import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateEnvironment } from '../apps/api/src/config/env.validation.js';
import { AuthBoundaryGuard } from '../apps/api/src/auth-boundary/auth-boundary.guard.js';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspacesService } from '../apps/api/src/workspaces/workspaces.service.js';
import { MerchantsService } from '../apps/api/src/merchants/merchants.service.js';
import { FeeAgreementsService } from '../apps/api/src/fee-agreements/fee-agreements.service.js';
import { SettlementPoliciesService } from '../apps/api/src/settlement-policies/settlement-policies.service.js';
import { CalendarsService } from '../apps/api/src/calendars/calendars.service.js';
import { EstimatesService } from '../apps/api/src/estimates/estimates.service.js';
import { HealthController } from '../apps/api/src/health/health.controller.js';
import { AuditService } from '../apps/api/src/audit/audit.service.js';
import type { PrismaService } from '../apps/api/src/database/prisma.service.js';

describe('Stage 4C.1: NestJS Cloud API & Data Foundation', () => {
  // --------------------------------------------------------------------------
  // 1. Environment & Configuration Validation
  // --------------------------------------------------------------------------
  describe('Environment Configuration Validation', () => {
    it('validates a correct environment configuration', () => {
      const config = {
        PORT: '4000',
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/trivio_dev',
        CORS_ORIGINS: 'http://localhost:3000,http://localhost:3002',
      };

      const validated = validateEnvironment(config);
      expect(validated.PORT).toBe(4000);
      expect(validated.NODE_ENV).toBe('development');
      expect(validated.DATABASE_URL).toBe('postgresql://postgres:postgres@localhost:5432/trivio_dev');
      expect(validated.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3002']);
    });

    it('rejects an invalid port number', () => {
      expect(() => validateEnvironment({ PORT: '99999' })).toThrow(/Invalid PORT/);
      expect(() => validateEnvironment({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    });

    it('rejects an invalid NODE_ENV', () => {
      expect(() => validateEnvironment({ NODE_ENV: 'staging' })).toThrow(/Invalid NODE_ENV/);
    });

    it('demands DATABASE_URL in production mode', () => {
      expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is mandatory/);
    });
  });

  // --------------------------------------------------------------------------
  // 2. AuthBoundaryGuard & Tenant Isolation
  // --------------------------------------------------------------------------
  describe('Tenant & Workspace Security Boundary', () => {
    let reflector: Reflector;
    let guard: AuthBoundaryGuard;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new AuthBoundaryGuard(reflector);
    });

    function mockExecutionContext(
      headers: Record<string, string> = {},
      isPublic = false,
      requiredRoles?: string[],
      authContext?: { workspaceId: string; actorId: string; roles?: string[] },
    ) {
      vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === 'isPublic') return isPublic;
        if (key === 'roles') return requiredRoles;
        return undefined;
      });

      const request = { headers, workspaceId: '', actorId: '', roles: [] as string[], authContext };
      return {
        getHandler: vi.fn(),
        getClass: vi.fn(),
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        _request: request,
      };
    }

    it('permits public routes without authentication headers', async () => {
      const ctx = mockExecutionContext({}, true);
      const allowed = await guard.canActivate(ctx as any);
      expect(allowed).toBe(true);
    });

    it('rejects unauthenticated requests missing workspace and actor context (deny-by-default)', async () => {
      const ctx = mockExecutionContext({});
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('negative test: strictly rejects forged x-test-* request headers off the wire', async () => {
      const ctx = mockExecutionContext({
        'x-test-workspace-id': 'ws_forged_hacker',
        'x-test-actor-id': 'usr_attacker_666',
        'x-test-roles': 'OWNER,ADMIN',
      });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(
        /Arbitrary test identity headers are strictly prohibited/,
      );
    });

    it('authenticates via controlled dependency-injected test AuthContextResolver', async () => {
      const testResolver = {
        resolve: vi.fn().mockResolvedValue({
          workspaceId: 'ws_acme_corp',
          actorId: 'usr_alice_123',
          roles: ['ADMIN', 'MEMBER'],
        }),
      };

      const customGuard = new AuthBoundaryGuard(reflector, testResolver);
      const ctx = mockExecutionContext({});

      const allowed = await customGuard.canActivate(ctx as any);
      expect(allowed).toBe(true);
      expect(ctx._request.workspaceId).toBe('ws_acme_corp');
      expect(ctx._request.actorId).toBe('usr_alice_123');
      expect(ctx._request.roles).toEqual(['ADMIN', 'MEMBER']);
    });

    it('enforces RBAC via AuthContextResolver and rejects actors lacking required roles', async () => {
      const testResolver = {
        resolve: vi.fn().mockResolvedValue({
          workspaceId: 'ws_acme_corp',
          actorId: 'usr_bob_viewer',
          roles: ['VIEWER'],
        }),
      };

      const customGuard = new AuthBoundaryGuard(reflector, testResolver);
      const ctx = mockExecutionContext({}, false, ['OWNER', 'ADMIN']);

      await expect(customGuard.canActivate(ctx as any)).rejects.toThrow(ForbiddenException);
    });

    it('prohibits public CRUD access in production without Stage 4C.2 authentication', async () => {
      const originalEnv = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';

      try {
        const testResolver = {
          resolve: vi.fn().mockResolvedValue({
            workspaceId: 'ws_acme_corp',
            actorId: 'usr_alice_123',
          }),
        };
        const customGuard = new AuthBoundaryGuard(reflector, testResolver);
        const ctx = mockExecutionContext({});

        await expect(customGuard.canActivate(ctx as any)).rejects.toThrow(ForbiddenException);
      } finally {
        process.env['NODE_ENV'] = originalEnv;
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Workspaces & Tenant Segregation Service
  // --------------------------------------------------------------------------
  describe('Workspaces Service & Isolation', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: WorkspacesService;

    beforeEach(() => {
      prismaMock = {
        workspace: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
        workspaceMember: {
          create: vi.fn(),
          findMany: vi.fn(),
        },
        userIdentity: {
          upsert: vi.fn(),
        },
        $transaction: vi.fn(async (cb) => cb(prismaMock)),
      };
      auditMock = {
        logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }),
      };
      service = new WorkspacesService(prismaMock, auditMock);
    });

    it('creates a workspace and assigns the creator as OWNER in an atomic transaction', async () => {
      prismaMock.workspace.findUnique.mockResolvedValue(null);
      prismaMock.workspace.create.mockResolvedValue({
        id: 'ws_100',
        name: 'Nexus Payments',
        slug: 'nexus-payments',
        status: 'ACTIVE',
      });

      const result = await service.createWorkspace('usr_founder', {
        name: 'Nexus Payments',
        slug: 'nexus-payments',
      });

      expect(result.id).toBe('ws_100');
      expect(prismaMock.workspaceMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 'ws_100',
          userId: 'usr_founder',
          role: 'OWNER',
        }),
      });
      expect(auditMock.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'WORKSPACE_CREATED',
          workspaceId: 'ws_100',
        }),
      );
    });

    it('rejects duplicate workspace slug', async () => {
      prismaMock.workspace.findUnique.mockResolvedValue({ id: 'ws_existing', slug: 'taken-slug' });

      await expect(
        service.createWorkspace('usr_founder', { name: 'Existing', slug: 'taken-slug' }),
      ).rejects.toThrow(/already taken/);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Merchants Service & Cross-Tenant Access Rejection
  // --------------------------------------------------------------------------
  describe('Merchants Service Isolation', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: MerchantsService;

    beforeEach(() => {
      prismaMock = {
        merchant: {
          findUnique: vi.fn(),
          findFirst: vi.fn(),
          findMany: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
      };
      auditMock = { logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }) };
      service = new MerchantsService(prismaMock, auditMock);
    });

    it('enforces workspace scoping on merchant creation and listing', async () => {
      prismaMock.merchant.findUnique.mockResolvedValue(null);
      prismaMock.merchant.create.mockResolvedValue({
        id: 'mer_1',
        workspaceId: 'ws_alpha',
        name: 'Merchant A',
        code: 'MER_A',
        currency: 'USD',
        acquirerId: 'ACQ_DEMO',
        status: 'ACTIVE',
      });

      const created = await service.createMerchant('ws_alpha', 'usr_admin', {
        name: 'Merchant A',
        code: 'MER_A',
        currency: 'usd',
        acquirerId: 'ACQ_DEMO',
      });

      expect(created.currency).toBe('USD');
      expect(prismaMock.merchant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ workspaceId: 'ws_alpha' }),
      });
    });

    it('negative test: Workspace B cannot inspect or mutate Workspace A merchant', async () => {
      // Mock findFirst returns null because merchant belongs to ws_alpha, but caller is ws_beta
      prismaMock.merchant.findFirst.mockResolvedValue(null);

      await expect(
        service.findMerchantById('ws_beta', 'mer_alpha_owned'),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.updateMerchant('ws_beta', 'usr_attacker', 'mer_alpha_owned', { name: 'Hacked' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Fee Agreements & Strict Minor Currency Serialization
  // --------------------------------------------------------------------------
  describe('Fee Agreements & Financial Boundary', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: FeeAgreementsService;

    beforeEach(() => {
      prismaMock = {
        merchant: { findFirst: vi.fn() },
        feeAgreement: {
          create: vi.fn(),
          findMany: vi.fn(),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      auditMock = { logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }) };
      service = new FeeAgreementsService(prismaMock, auditMock);
    });

    it('accepts explicit zero-fee agreements and preserves BigInt precision', async () => {
      prismaMock.feeAgreement.create.mockImplementation(({ data }: any) => ({
        id: 'fee_zero',
        ...data,
      }));

      const result = await service.createFeeAgreement('ws_alpha', 'usr_admin', {
        name: 'Zero-Fee Promotional Tier',
        acquirerId: 'ACQ_DEMO',
        percentageBps: 0, // 0.00% MDR
        fixedFeeMinor: '0', // $0.00 fixed
      });

      expect(result.percentageBps).toBe(0);
      expect(result.fixedFeeMinor).toBe('0');
      expect(prismaMock.feeAgreement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          percentageBps: 0,
          fixedFeeMinor: 0n,
        }),
      });
    });

    it('rejects cross-tenant merchant association on fee agreement', async () => {
      // Merchant does not belong to ws_alpha
      prismaMock.merchant.findFirst.mockResolvedValue(null);

      await expect(
        service.createFeeAgreement('ws_alpha', 'usr_admin', {
          merchantId: 'mer_foreign_workspace',
          name: 'Illegal Tier',
          acquirerId: 'ACQ_DEMO',
          percentageBps: 200,
          fixedFeeMinor: '30',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('archives fee agreement rather than destructively deleting historical records', async () => {
      prismaMock.feeAgreement.findFirst.mockResolvedValue({
        id: 'fee_active',
        workspaceId: 'ws_alpha',
        fixedFeeMinor: 30n,
      });
      prismaMock.feeAgreement.update.mockResolvedValue({
        id: 'fee_active',
        workspaceId: 'ws_alpha',
        status: 'DEPRECATED',
        fixedFeeMinor: 30n,
      });

      const archived = await service.archiveFeeAgreement('ws_alpha', 'usr_admin', 'fee_active');
      expect(archived.status).toBe('DEPRECATED');
      expect(prismaMock.feeAgreement.update).toHaveBeenCalledWith({
        where: { id: 'fee_active' },
        data: { status: 'DEPRECATED' },
      });
    });
  });

  // --------------------------------------------------------------------------
  // 6. Settlement Policies & Clearance Validation
  // --------------------------------------------------------------------------
  describe('Settlement Policies Service', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: SettlementPoliciesService;

    beforeEach(() => {
      prismaMock = {
        merchant: { findFirst: vi.fn() },
        settlementCalendar: { findFirst: vi.fn() },
        settlementPolicy: {
          create: vi.fn(),
          findMany: vi.fn(),
          findFirst: vi.fn(),
          update: vi.fn(),
        },
      };
      auditMock = { logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }) };
      service = new SettlementPoliciesService(prismaMock, auditMock);
    });

    it('creates settlement policy with validated UTC cut-off and weekend convention', async () => {
      prismaMock.settlementPolicy.create.mockImplementation(({ data }: any) => ({
        id: 'pol_t2',
        ...data,
      }));

      const policy = await service.createSettlementPolicy('ws_alpha', 'usr_admin', {
        name: 'Standard T+2 Federal Reserve',
        acquirerId: 'ACQ_DEMO',
        cycleDays: 2,
        cutOffTimeUtc: '16:00',
        timeZone: 'America/New_York',
        weekendHandling: 'following_business_day',
      });

      expect(policy.cycleDays).toBe(2);
      expect(policy.cutOffTimeUtc).toBe('16:00');
      expect(policy.weekendHandling).toBe('following_business_day');
    });

    it('rejects foreign calendar association outside caller workspace', async () => {
      prismaMock.settlementCalendar.findFirst.mockResolvedValue(null);

      await expect(
        service.createSettlementPolicy('ws_alpha', 'usr_admin', {
          name: 'Invalid Calendar Policy',
          acquirerId: 'ACQ_DEMO',
          cycleDays: 2,
          cutOffTimeUtc: '16:00',
          timeZone: 'America/New_York',
          calendarId: 'cal_other_workspace',
          weekendHandling: 'following_business_day',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Calendars Service
  // --------------------------------------------------------------------------
  describe('Calendars Service', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: CalendarsService;

    beforeEach(() => {
      prismaMock = {
        settlementCalendar: {
          create: vi.fn(),
          findMany: vi.fn(),
          findFirst: vi.fn(),
        },
      };
      auditMock = { logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }) };
      service = new CalendarsService(prismaMock, auditMock);
    });

    it('creates a settlement calendar with working days and holiday dates', async () => {
      prismaMock.settlementCalendar.create.mockImplementation(({ data }: any) => ({
        id: 'cal_us',
        ...data,
      }));

      const calendar = await service.createCalendar('ws_alpha', 'usr_admin', {
        name: 'US Federal Reserve Calendar',
        timeZone: 'America/New_York',
        workingDays: [1, 2, 3, 4, 5],
        holidays: ['2026-01-01', '2026-12-25'],
      });

      expect(calendar.workingDays).toEqual([1, 2, 3, 4, 5]);
      expect(calendar.holidays).toContain('2026-12-25');
    });
  });

  // --------------------------------------------------------------------------
  // 8. Financial Calculation Endpoint & Core Engine Integration
  // --------------------------------------------------------------------------
  describe('Estimates Service (@trivio.ink/core Integration)', () => {
    let prismaMock: any;
    let auditMock: any;
    let service: EstimatesService;

    beforeEach(() => {
      prismaMock = {
        merchant: { findFirst: vi.fn() },
        feeAgreement: { findMany: vi.fn().mockResolvedValue([]) },
        settlementPolicy: { findMany: vi.fn().mockResolvedValue([]) },
        settlementCalendar: { findMany: vi.fn().mockResolvedValue([]) },
        estimateRecord: {
          create: vi.fn().mockImplementation(({ data }: any) => ({
            id: 'est_rec_123',
            ...data,
          })),
        },
      };
      auditMock = { logEvent: vi.fn().mockResolvedValue({ id: 'evt_1' }) };
      service = new EstimatesService(prismaMock, auditMock);
    });

    it('calculates deterministic payout with zero-float integer math', async () => {
      const estimate = await service.calculateEstimate('ws_alpha', 'usr_dev', {
        grossMinor: '1000000', // $10,000.00
        currency: 'USD',
        transactionTime: '2026-11-20T17:30:00Z',
        acquirerId: 'ACQ_DEMO',
        persist: false,
      });

      expect(estimate.status).toBe('ESTIMATED');
      expect(estimate.grossMinor).toBe('1000000');
      // 2.20% of $10,000.00 = $220.00 (22,000 minor) + $0.30 fixed (30 minor) = $220.30 total fee (22,030 minor)
      // Net = 1,000,000 - 22,030 = 977,970 minor ($9,779.70)
      expect(estimate.totalFeeMinor).toBe('22030');
      expect(estimate.netMinor).toBe('977970');
      expect(estimate.expectedSettlementDate).toBeDefined();
    });

    it('correctly flags cut-off and rolls clearance date forward when transaction is after cut-off', async () => {
      // 21:30 UTC is 16:30 EST (after 16:00 cut-off) on Friday Nov 20, 2026
      const estimate = await service.calculateEstimate('ws_alpha', 'usr_dev', {
        grossMinor: '1000000',
        currency: 'USD',
        transactionTime: '2026-11-20T21:30:00Z',
        acquirerId: 'ACQ_DEMO',
        persist: true,
      });

      expect(estimate.isPastCutOff).toBe(true);
      expect(estimate.estimateRecordId).toBe('est_rec_123');
      expect(prismaMock.estimateRecord.create).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // 9. Public Health Check Controller
  // --------------------------------------------------------------------------
  describe('Health Controller', () => {
    it('returns service status and database connectivity info', async () => {
      const prismaMock = {
        $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
      };
      const controller = new HealthController(prismaMock as unknown as PrismaService);

      const health = await controller.getHealth();
      expect(health.status).toBe('ok');
      expect(health.service).toBe('@trivio-apps/api');
      expect(health.version).toBe('0.1.0');
      expect(health.database).toBe('CONNECTED');
    });

    it('reports UNREACHABLE database status cleanly without crashing when database is offline', async () => {
      const prismaMock = {
        $queryRaw: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const controller = new HealthController(prismaMock as unknown as PrismaService);

      const health = await controller.getHealth();
      expect(health.status).toBe('ok');
      expect(health.database).toBe('UNREACHABLE');
    });
  });
});
