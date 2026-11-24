-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "acquirerId" TEXT NOT NULL DEFAULT 'ACQ_DEMO',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_agreements" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "acquirerId" TEXT NOT NULL DEFAULT 'ACQ_DEMO',
    "percentageBps" INTEGER NOT NULL,
    "fixedFeeMinor" BIGINT NOT NULL,
    "minFeeMinor" BIGINT,
    "maxFeeMinor" BIGINT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rateSource" TEXT NOT NULL DEFAULT 'merchant_configured',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_policies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "acquirerId" TEXT NOT NULL DEFAULT 'ACQ_DEMO',
    "cycleDays" INTEGER NOT NULL DEFAULT 2,
    "cycleUnit" TEXT NOT NULL DEFAULT 'business_days',
    "cutOffTimeUtc" TEXT NOT NULL DEFAULT '16:00',
    "timeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "calendarId" TEXT,
    "weekendHandling" TEXT NOT NULL DEFAULT 'following_business_day',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_calendars" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "timeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "workingDays" INTEGER[],
    "holidays" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_records" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantId" TEXT,
    "grossMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "totalFeeMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "transactionTime" TIMESTAMP(3) NOT NULL,
    "expectedSettlementDate" TEXT NOT NULL,
    "isPastCutOff" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ESTIMATED',
    "feeBreakdownJson" JSONB NOT NULL,
    "settlementPolicyJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimate_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_workspaceId_idx" ON "workspace_members"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_members_userId_idx" ON "workspace_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_userId_key" ON "workspace_members"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_externalId_key" ON "user_identities"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_email_key" ON "user_identities"("email");

-- CreateIndex
CREATE INDEX "merchants_workspaceId_idx" ON "merchants"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_workspaceId_code_key" ON "merchants"("workspaceId", "code");

-- CreateIndex
CREATE INDEX "fee_agreements_workspaceId_idx" ON "fee_agreements"("workspaceId");

-- CreateIndex
CREATE INDEX "fee_agreements_merchantId_idx" ON "fee_agreements"("merchantId");

-- CreateIndex
CREATE INDEX "settlement_policies_workspaceId_idx" ON "settlement_policies"("workspaceId");

-- CreateIndex
CREATE INDEX "settlement_policies_merchantId_idx" ON "settlement_policies"("merchantId");

-- CreateIndex
CREATE INDEX "settlement_policies_calendarId_idx" ON "settlement_policies"("calendarId");

-- CreateIndex
CREATE INDEX "settlement_calendars_workspaceId_idx" ON "settlement_calendars"("workspaceId");

-- CreateIndex
CREATE INDEX "estimate_records_workspaceId_idx" ON "estimate_records"("workspaceId");

-- CreateIndex
CREATE INDEX "estimate_records_merchantId_idx" ON "estimate_records"("merchantId");

-- CreateIndex
CREATE INDEX "audit_events_workspaceId_idx" ON "audit_events"("workspaceId");

-- CreateIndex
CREATE INDEX "audit_events_timestamp_idx" ON "audit_events"("timestamp");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_agreements" ADD CONSTRAINT "fee_agreements_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_agreements" ADD CONSTRAINT "fee_agreements_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_policies" ADD CONSTRAINT "settlement_policies_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_policies" ADD CONSTRAINT "settlement_policies_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_policies" ADD CONSTRAINT "settlement_policies_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "settlement_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_calendars" ADD CONSTRAINT "settlement_calendars_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_records" ADD CONSTRAINT "estimate_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_records" ADD CONSTRAINT "estimate_records_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
