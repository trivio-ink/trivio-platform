import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { WorkspacesService } from '../apps/api/src/workspaces/workspaces.service.js';
import { MerchantsService } from '../apps/api/src/merchants/merchants.service.js';
import { FeeAgreementsService } from '../apps/api/src/fee-agreements/fee-agreements.service.js';
import { AuditService } from '../apps/api/src/audit/audit.service.js';
import type { PrismaService } from '../apps/api/src/database/prisma.service.js';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

// Load local .env if available without external dependencies
function loadLocalEnv() {
  for (const envFile of ['.env', 'apps/api/.env']) {
    const fullPath = path.resolve(process.cwd(), envFile);
    if (fs.existsSync(fullPath)) {
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match && match[1]) {
          const key = match[1];
          let val = (match[2] || '').trim();
          if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
          if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}
loadLocalEnv();

const connectionString =
  process.env['DATABASE_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/trivio_test?schema=public';

const prisma = new PrismaClient({
  datasources: { db: { url: connectionString } },
  log: ['error'],
});

let isDbAvailable = false;

try {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  isDbAvailable = true;
} catch (error) {
  console.warn(
    `[api-db.integration] PostgreSQL not reachable at ${connectionString.replace(/:[^:@]+@/, ':***@')}. DB tests will be skipped. Error: ${(error as Error).message}`,
  );
  isDbAvailable = false;
}

describe('Stage 4C.1: Real PostgreSQL Integration & Tenant Isolation', () => {
  it('verifies PostgreSQL connectivity and test environment status', () => {
    if (!isDbAvailable) {
      if (process.env['CI'] || process.env['REQUIRE_DB'] === 'true') {
        throw new Error(
          `Mandatory PostgreSQL integration test failed: Database is unreachable at ${connectionString.replace(/:[^:@]+@/, ':***@')}. Real DB tests are mandatory in CI.`,
        );
      }
      console.warn('Skipping real PostgreSQL tests: PostgreSQL server is offline or unreachable.');
    }
    expect(true).toBe(true);
  });

  describe.runIf(isDbAvailable)('Live Database Operations', () => {
    const testRunId = Date.now().toString(36);
    const alphaSlug = `int-test-alpha-${testRunId}`;
    const betaSlug = `int-test-beta-${testRunId}`;
    const actorAlpha = `usr_alpha_${testRunId}`;
    const actorBeta = `usr_beta_${testRunId}`;

    let auditService: AuditService;
    let workspacesService: WorkspacesService;
    let merchantsService: MerchantsService;
    let feeAgreementsService: FeeAgreementsService;

    let workspaceAlphaId: string;
    let workspaceBetaId: string;
    let merchantAlphaId: string;
    let merchantBetaId: string;

    beforeAll(async () => {
      const ps = prisma as unknown as PrismaService;
      auditService = new AuditService(ps);
      workspacesService = new WorkspacesService(ps, auditService);
      merchantsService = new MerchantsService(ps, auditService);
      feeAgreementsService = new FeeAgreementsService(ps, auditService);
    });

    afterAll(async () => {
      try {
        // Cascade cleanup by removing created workspaces
        await prisma.workspace.deleteMany({
          where: {
            slug: { in: [alphaSlug, betaSlug, `rollback-${testRunId}`, `fail-audit-${testRunId}`] },
          },
        });
      } finally {
        await prisma.$disconnect();
      }
    });

    // --------------------------------------------------------------------------
    // 1. Schema & Table Integrity Verification
    // --------------------------------------------------------------------------
    it('confirms all 9 domain tables exist in the PostgreSQL schema', async () => {
      const tables: Array<{ table_name: string }> = await prisma.$queryRaw`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `;
      const tableNames = tables.map((t) => t.table_name);

      expect(tableNames).toContain('workspaces');
      expect(tableNames).toContain('workspace_members');
      expect(tableNames).toContain('user_identities');
      expect(tableNames).toContain('merchants');
      expect(tableNames).toContain('fee_agreements');
      expect(tableNames).toContain('settlement_policies');
      expect(tableNames).toContain('settlement_calendars');
      expect(tableNames).toContain('estimate_records');
      expect(tableNames).toContain('audit_events');
    });

    // --------------------------------------------------------------------------
    // 2. Workspace Creation & Owner Membership in Real Transaction
    // --------------------------------------------------------------------------
    it('creates workspaces and atomically persists owner membership and audit record', async () => {
      const wsAlpha = await workspacesService.createWorkspace(actorAlpha, {
        name: `Alpha Payments Corp ${testRunId}`,
        slug: alphaSlug,
      });
      workspaceAlphaId = wsAlpha.id;
      expect(wsAlpha.id).toBeDefined();
      expect(wsAlpha.slug).toBe(alphaSlug);

      const wsBeta = await workspacesService.createWorkspace(actorBeta, {
        name: `Beta Global Commerce ${testRunId}`,
        slug: betaSlug,
      });
      workspaceBetaId = wsBeta.id;
      expect(wsBeta.id).toBeDefined();

      // Verify row persisted in real database
      const rowAlpha = await prisma.workspace.findUnique({
        where: { id: workspaceAlphaId },
        include: { members: true },
      });
      expect(rowAlpha).not.toBeNull();
      expect(rowAlpha?.members.length).toBe(1);
      expect(rowAlpha?.members[0]?.userId).toBe(actorAlpha);
      expect(rowAlpha?.members[0]?.role).toBe('OWNER');

      // Verify user identity was created
      const userIdentity = await prisma.userIdentity.findUnique({
        where: { id: actorAlpha },
      });
      expect(userIdentity).not.toBeNull();
      expect(userIdentity?.email).toBe(`${actorAlpha}@trivio.internal`);
    });

    it('enforces unique workspace slug at PostgreSQL constraint level', async () => {
      await expect(
        workspacesService.createWorkspace(actorAlpha, {
          name: 'Duplicate Alpha Slug',
          slug: alphaSlug,
        }),
      ).rejects.toThrow(ConflictException);
    });

    // --------------------------------------------------------------------------
    // 3. Multi-Tenant Merchant Scoping & Composite Unique Constraints
    // --------------------------------------------------------------------------
    it('permits identical merchant codes across different workspaces but enforces uniqueness within the same workspace', async () => {
      // Create merchant in Workspace Alpha with code "MERCH_DEMO"
      const mAlpha = await merchantsService.createMerchant(workspaceAlphaId, actorAlpha, {
        name: 'Alpha Retailer',
        code: 'MERCH_DEMO',
        currency: 'USD',
        acquirerId: 'ACQ_DEMO',
      });
      merchantAlphaId = mAlpha.id;
      expect(mAlpha.code).toBe('MERCH_DEMO');
      expect(mAlpha.workspaceId).toBe(workspaceAlphaId);

      // Create merchant in Workspace Beta with the identical code "MERCH_DEMO" (allowed cross-workspace)
      const mBeta = await merchantsService.createMerchant(workspaceBetaId, actorBeta, {
        name: 'Beta Retailer',
        code: 'MERCH_DEMO',
        currency: 'EUR',
        acquirerId: 'ACQ_DEMO',
      });
      merchantBetaId = mBeta.id;
      expect(mBeta.code).toBe('MERCH_DEMO');
      expect(mBeta.workspaceId).toBe(workspaceBetaId);
      expect(mBeta.id).not.toBe(mAlpha.id);

      // Attempt duplicate code inside Workspace Alpha (must fail)
      await expect(
        merchantsService.createMerchant(workspaceAlphaId, actorAlpha, {
          name: 'Alpha Retailer Duplicate',
          code: 'MERCH_DEMO',
          currency: 'USD',
          acquirerId: 'ACQ_DEMO',
        }),
      ).rejects.toThrow(ConflictException);
    });

    // --------------------------------------------------------------------------
    // 4. Cross-Tenant Access Isolation (Negative Tests)
    // --------------------------------------------------------------------------
    it('strictly prevents Workspace Beta from reading or updating Workspace Alpha merchants', async () => {
      // Workspace Beta tries to find Workspace Alpha's merchant
      await expect(
        merchantsService.findMerchantById(workspaceBetaId, merchantAlphaId),
      ).rejects.toThrow(NotFoundException);

      // Workspace Beta tries to update Workspace Alpha's merchant
      await expect(
        merchantsService.updateMerchant(workspaceBetaId, actorBeta, merchantAlphaId, {
          name: 'Malicious Update',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    // --------------------------------------------------------------------------
    // 5. Zero-Float BigInt Financial Precision in Fee Agreements
    // --------------------------------------------------------------------------
    it('persists and retrieves exact BigInt minor currency units without float corruption', async () => {
      const created = await feeAgreementsService.createFeeAgreement(workspaceAlphaId, actorAlpha, {
        merchantId: merchantAlphaId,
        name: 'Standard Interchange Plus Tier',
        acquirerId: 'ACQ_DEMO',
        percentageBps: 220, // 2.20%
        fixedFeeMinor: '3500', // $35.00 fixed
        minFeeMinor: '50', // $0.50
        maxFeeMinor: '250000', // $2,500.00
      });

      expect(created.fixedFeeMinor).toBe('3500');
      expect(created.minFeeMinor).toBe('50');
      expect(created.maxFeeMinor).toBe('250000');

      // Verify direct database representation is BigInt, not IEEE-754 float
      const dbRecord = await prisma.feeAgreement.findUnique({
        where: { id: created.id as string },
      });

      expect(dbRecord).not.toBeNull();
      expect(typeof dbRecord?.fixedFeeMinor).toBe('bigint');
      expect(dbRecord?.fixedFeeMinor).toBe(3500n);
      expect(dbRecord?.minFeeMinor).toBe(50n);
      expect(dbRecord?.maxFeeMinor).toBe(250000n);
      expect(dbRecord?.percentageBps).toBe(220);
    });

    // --------------------------------------------------------------------------
    // 6. Cross-Tenant Foreign Key Rejection on Fee Agreements
    // --------------------------------------------------------------------------
    it('rejects associating Workspace Beta merchant with Workspace Alpha fee agreement', async () => {
      await expect(
        feeAgreementsService.createFeeAgreement(workspaceAlphaId, actorAlpha, {
          merchantId: merchantBetaId, // Belongs to Beta, not Alpha!
          name: 'Illegal Cross-Tenant Tier',
          acquirerId: 'ACQ_DEMO',
          percentageBps: 180,
          fixedFeeMinor: '25',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    // --------------------------------------------------------------------------
    // 7. Atomic Transaction Rollback on Failure
    // --------------------------------------------------------------------------
    it('rolls back database mutations completely when a multi-step transaction fails', async () => {
      const rollbackSlug = `rollback-${testRunId}`;

      const attemptTransaction = async () => {
        await prisma.$transaction(async (tx) => {
          await tx.workspace.create({
            data: {
              name: 'Failed Atomic Workspace',
              slug: rollbackSlug,
              status: 'ACTIVE',
            },
          });
          // Deliberately trigger failure in the second step
          throw new Error('Simulated atomic transaction failure');
        });
      };

      await expect(attemptTransaction()).rejects.toThrow('Simulated atomic transaction failure');

      // Verify the workspace was rolled back and does not exist in PostgreSQL
      const orphaned = await prisma.workspace.findUnique({
        where: { slug: rollbackSlug },
      });
      expect(orphaned).toBeNull();
    });

    it('verifies that an audit write failure inside the atomic transaction rolls back workspace and member creation', async () => {
      const failingSlug = `fail-audit-${testRunId}`;
      const mockFailingAudit = {
        logEvent: vi.fn().mockRejectedValue(new Error('Simulated atomic audit failure')),
        listEventsByWorkspace: vi.fn(),
      } as unknown as AuditService;

      const failingWorkspacesService = new WorkspacesService(
        prisma as unknown as PrismaService,
        mockFailingAudit,
      );

      await expect(
        failingWorkspacesService.createWorkspace(`usr_audit_fail_${testRunId}`, {
          name: 'Failing Audit Workspace',
          slug: failingSlug,
        }),
      ).rejects.toThrow('Simulated atomic audit failure');

      // Verify that neither the workspace nor any membership was committed to PostgreSQL
      const orphanedWs = await prisma.workspace.findUnique({
        where: { slug: failingSlug },
      });
      expect(orphanedWs).toBeNull();
    });

    // --------------------------------------------------------------------------
    // 8. Audit Event Persistence & JSON Metadata Verification
    // --------------------------------------------------------------------------
    it('persists structured audit events with JSON payload in PostgreSQL', async () => {
      const events = await auditService.listEventsByWorkspace(workspaceAlphaId);
      expect(events.length).toBeGreaterThanOrEqual(2);

      const actions = events.map((e) => e.action);
      expect(actions).toContain('WORKSPACE_CREATED');
      expect(actions).toContain('MERCHANT_CREATED');
      expect(actions).toContain('FEE_AGREEMENT_CREATED');

      const feeEvent = events.find((e) => e.action === 'FEE_AGREEMENT_CREATED');
      expect(feeEvent).toBeDefined();
      expect(feeEvent?.entityType).toBe('FeeAgreement');
      expect(feeEvent?.payloadJson).toMatchObject({
        percentageBps: 220,
        fixedFeeMinor: '3500',
      });
    });
  });
});
