import type { Endpoint } from ".prisma/client";
import type { SourceMetadata } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger";
import { workerQueue } from "../worker.server";
import { generateSecret } from "./utils.server";

export class RegisterSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(endpointId: string, metadata: SourceMetadata) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id: endpointId,
      },
      include: {
        environment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    await this.#upsertSource(endpoint, endpoint.environment, metadata);
  }

  async #upsertSource(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: SourceMetadata
  ) {
    logger.debug("Upserting source", {
      endpoint,
      organizationId: environment.organizationId,
      metadata,
    });

    const { id, orphanedEvents } = await this.#prismaClient.$transaction(
      async (tx) => {
        const triggerSource = await tx.triggerSource.upsert({
          where: {
            key_endpointId: {
              endpointId: endpoint.id,
              key: metadata.key,
            },
          },
          create: {
            params: metadata.params,
            key: metadata.key,
            channel: metadata.channel,
            organization: {
              connect: {
                id: environment.organizationId,
              },
            },
            endpoint: {
              connect: {
                id: endpoint.id,
              },
            },
            project: {
              connect: {
                id: environment.projectId,
              },
            },
            environment: {
              connect: {
                id: environment.id,
              },
            },
            events: {
              create: metadata.events.map((event) => ({
                name: event,
              })),
            },
            secretReference: {
              connectOrCreate: {
                where: {
                  key: `${endpoint.id}:${metadata.key}`,
                },
                create: {
                  key: `${endpoint.id}:${metadata.key}`,
                  provider: "database",
                },
              },
            },
          },
          update: {},
          include: {
            events: true,
            secretReference: true,
          },
        });

        switch (metadata.channel) {
          case "HTTP": {
            await tx.secretStore.upsert({
              where: {
                key: triggerSource.secretReference.key,
              },
              create: {
                key: triggerSource.secretReference.key,
                value: {
                  secret: generateSecret(),
                },
              },
              update: {},
            });
          }
        }

        const newEvents = new Set<string>(metadata.events);
        const orphanedEvents = new Set<string>();

        for (const event of triggerSource.events) {
          if (!newEvents.has(event.name)) {
            orphanedEvents.add(event.name);
          }
        }

        for (const event of newEvents) {
          await tx.triggerSourceEvent.upsert({
            where: {
              name_sourceId: {
                name: event,
                sourceId: triggerSource.id,
              },
            },
            create: {
              name: event,
              source: {
                connect: {
                  id: triggerSource.id,
                },
              },
            },
            update: {},
          });
        }

        return {
          id: triggerSource.id,
          orphanedEvents: Array.from(orphanedEvents),
        };
      }
    );

    // We need to activate the source if:
    // 1. It's not active
    // 2. There are orphaned events
    // 3. There are trigger events that are not registered
    const triggerSource =
      await this.#prismaClient.triggerSource.findUniqueOrThrow({
        where: {
          id: id,
        },
        include: {
          events: true,
        },
      });

    const triggerIsActive = triggerSource.active;
    const triggerHasOrphanedEvents = orphanedEvents.length > 0;
    const triggerHasUnregisteredEvents = triggerSource.events.some(
      (event) => !event.registered
    );

    if (
      !triggerIsActive ||
      triggerHasOrphanedEvents ||
      triggerHasUnregisteredEvents
    ) {
      // We need to re-activate the source, and there could be orphaned events
      await workerQueue.enqueue("activateSource", {
        id: triggerSource.id,
        orphanedEvents: orphanedEvents,
      });
    }
  }
}