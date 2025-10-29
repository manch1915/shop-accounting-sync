-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "webhookSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "statusReason" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "tokenExpiresAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storeConnectionId" TEXT NOT NULL,
    "accountingConnectionId" TEXT NOT NULL,
    "flags" JSONB NOT NULL,
    "currency" TEXT NOT NULL,
    "reconcileEveryMin" INTEGER NOT NULL DEFAULT 15,
    "reconciledUntil" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "storeProductId" TEXT NOT NULL,
    "storeVariantId" TEXT NOT NULL DEFAULT '',
    "storeSku" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "barcode" TEXT,
    "accountingProductId" TEXT,
    "accountingName" TEXT,
    "matchedBy" TEXT,
    "lastStock" INTEGER,
    "lastPriceMinor" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValueMapping" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "target" TEXT,
    "targetLabel" TEXT,

    CONSTRAINT "ValueMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityLink" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "accountingId" TEXT NOT NULL,
    "accountingUrl" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "subject" TEXT NOT NULL,
    "subjectRef" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorParams" JSONB,
    "errorDetail" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "conflictId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationEvent" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HttpExchange" (
    "id" TEXT NOT NULL,
    "operationId" TEXT,
    "connectionId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestHeaders" JSONB NOT NULL,
    "requestBody" TEXT,
    "status" INTEGER,
    "responseHeaders" JSONB NOT NULL,
    "responseBody" TEXT,
    "durationMs" INTEGER NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HttpExchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Connection_workspaceId_idx" ON "Connection"("workspaceId");

-- CreateIndex
CREATE INDEX "Integration_workspaceId_idx" ON "Integration"("workspaceId");

-- CreateIndex
CREATE INDEX "ProductMapping_integrationId_storeSku_idx" ON "ProductMapping"("integrationId", "storeSku");

-- CreateIndex
CREATE INDEX "ProductMapping_integrationId_accountingProductId_idx" ON "ProductMapping"("integrationId", "accountingProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_integrationId_storeProductId_storeVariantId_key" ON "ProductMapping"("integrationId", "storeProductId", "storeVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ValueMapping_integrationId_kind_source_key" ON "ValueMapping"("integrationId", "kind", "source");

-- CreateIndex
CREATE UNIQUE INDEX "EntityLink_integrationId_entity_storeId_key" ON "EntityLink"("integrationId", "entity", "storeId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_receivedAt_idx" ON "WebhookReceipt"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_connectionId_deliveryId_key" ON "WebhookReceipt"("connectionId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_dedupeKey_key" ON "Operation"("dedupeKey");

-- CreateIndex
CREATE INDEX "Operation_integrationId_createdAt_idx" ON "Operation"("integrationId", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_status_updatedAt_idx" ON "Operation"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Operation_type_createdAt_idx" ON "Operation"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_conflictId_idx" ON "Operation"("conflictId");

-- CreateIndex
CREATE INDEX "OperationEvent_operationId_at_idx" ON "OperationEvent"("operationId", "at");

-- CreateIndex
CREATE INDEX "HttpExchange_operationId_createdAt_idx" ON "HttpExchange"("operationId", "createdAt");

-- CreateIndex
CREATE INDEX "HttpExchange_connectionId_createdAt_idx" ON "HttpExchange"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "Conflict_status_idx" ON "Conflict"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Conflict_integrationId_kind_key_key" ON "Conflict"("integrationId", "kind", "key");

-- CreateIndex
CREATE INDEX "Alert_workspaceId_createdAt_idx" ON "Alert"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_dedupeKey_createdAt_idx" ON "Alert"("dedupeKey", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_storeConnectionId_fkey" FOREIGN KEY ("storeConnectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_accountingConnectionId_fkey" FOREIGN KEY ("accountingConnectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMapping" ADD CONSTRAINT "ProductMapping_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValueMapping" ADD CONSTRAINT "ValueMapping_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_conflictId_fkey" FOREIGN KEY ("conflictId") REFERENCES "Conflict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationEvent" ADD CONSTRAINT "OperationEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpExchange" ADD CONSTRAINT "HttpExchange_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpExchange" ADD CONSTRAINT "HttpExchange_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
