import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '@prisma/client';

export interface RecordAuditEventInput {
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  tx?: Prisma.TransactionClient;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logEvent(input: RecordAuditEventInput) {
    const client = input.tx ?? this.prisma;
    try {
      const record = await client.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          payloadJson: input.payload as Prisma.InputJsonValue,
        },
      });
      return record;
    } catch (error) {
      this.logger.error(`Failed to record audit event: ${(error as Error).message}`);
      if (input.tx) {
        throw error;
      }
      return null;
    }
  }

  async listEventsByWorkspace(workspaceId: string, limit = 50) {
    return this.prisma.auditEvent.findMany({
      where: { workspaceId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }
}
