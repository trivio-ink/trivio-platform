import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateWorkspaceDto } from './dto/create-workspace.dto.js';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createWorkspace(actorId: string, dto: CreateWorkspaceDto) {
    const existing = await this.prisma.workspace.findUnique({
      where: { slug: dto.slug },
    });

    if (existing) {
      throw new ConflictException(`Workspace slug '${dto.slug}' is already taken.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          status: 'ACTIVE',
        },
      });

      // Ensure user identity exists or create placeholder for actor
      await tx.userIdentity.upsert({
        where: { id: actorId },
        update: {},
        create: {
          id: actorId,
          email: `${actorId}@trivio.internal`,
          name: 'Workspace Owner',
        },
      });

      // Assign actor as OWNER
      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: actorId,
          role: 'OWNER',
        },
      });

      // Transaction-scoped audit write: guarantees atomic creation or full rollback
      await this.audit.logEvent({
        workspaceId: workspace.id,
        actorId,
        action: 'WORKSPACE_CREATED',
        entityType: 'Workspace',
        entityId: workspace.id,
        payload: { name: workspace.name, slug: workspace.slug },
        tx,
      });

      return workspace;
    });
  }

  async findById(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          include: { user: true },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found.`);
    }

    return workspace;
  }

  async listWorkspacesForActor(actorId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: actorId },
      include: { workspace: true },
    });

    return memberships.map((m) => ({
      ...m.workspace,
      role: m.role,
    }));
  }
}
