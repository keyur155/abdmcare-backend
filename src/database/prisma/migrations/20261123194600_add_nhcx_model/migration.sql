-- CreateEnum
CREATE TYPE "NHCXScheme" AS ENUM ('IRDAI', 'PMJAY');

-- CreateEnum
CREATE TYPE "NHCXParticipantStatus" AS ENUM ('NOT_REGISTERED', 'PENDING', 'ACTIVE', 'SUSPENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "NHCXTransactionStatus" AS ENUM ('CREATED', 'SENT', 'ACKNOWLEDGED', 'PROCESSING', 'SUCCESS', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "NHCXTransactionDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "NHCXPreAuthStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'APPROVED', 'PARTIALLY_APPROVED', 'QUERIED', 'DENIED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NHCXClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'PROCESSING', 'QUERIED', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InsurancePolicyStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'EXPIRED', 'CANCELLED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "hospitals" ADD COLUMN     "nhcxEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "nhcx_participants" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantName" TEXT NOT NULL,
    "status" "NHCXParticipantStatus" NOT NULL DEFAULT 'NOT_REGISTERED',
    "callbackUrl" TEXT,
    "registeredAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nhcx_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nhcx_certificates" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "certificateId" TEXT,
    "certificateType" TEXT,
    "publicKey" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nhcx_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "scheme" "NHCXScheme" NOT NULL,
    "payerId" TEXT,
    "payerName" TEXT,
    "policyNumber" TEXT,
    "memberId" TEXT,
    "beneficiaryId" TEXT,
    "policyName" TEXT,
    "coverageAmount" DECIMAL(12,2),
    "availableAmount" DECIMAL(12,2),
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "status" "InsurancePolicyStatus" NOT NULL DEFAULT 'UNKNOWN',
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nhcx_preauths" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "admissionId" TEXT,
    "policyId" TEXT NOT NULL,
    "preAuthNumber" TEXT,
    "requestedAmount" DECIMAL(12,2) NOT NULL,
    "approvedAmount" DECIMAL(12,2),
    "diagnosis" JSONB,
    "treatmentDetails" JSONB,
    "status" "NHCXPreAuthStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "payerReference" TEXT,
    "responseData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nhcx_preauths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nhcx_claims" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "admissionId" TEXT,
    "policyId" TEXT NOT NULL,
    "preAuthId" TEXT,
    "claimNumber" TEXT,
    "requestedAmount" DECIMAL(12,2) NOT NULL,
    "approvedAmount" DECIMAL(12,2),
    "paidAmount" DECIMAL(12,2),
    "status" "NHCXClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "payerReference" TEXT,
    "responseData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nhcx_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nhcx_transactions" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "preAuthId" TEXT,
    "claimId" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "transactionId" TEXT,
    "apiCallId" TEXT,
    "useCase" TEXT NOT NULL,
    "workflowCode" TEXT,
    "endpoint" TEXT NOT NULL,
    "direction" "NHCXTransactionDirection" NOT NULL,
    "status" "NHCXTransactionStatus" NOT NULL DEFAULT 'CREATED',
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nhcx_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nhcx_participants_participantId_key" ON "nhcx_participants"("participantId");

-- CreateIndex
CREATE INDEX "nhcx_participants_hospitalId_idx" ON "nhcx_participants"("hospitalId");

-- CreateIndex
CREATE INDEX "nhcx_certificates_participantId_idx" ON "nhcx_certificates"("participantId");

-- CreateIndex
CREATE INDEX "insurance_policies_patientId_hospitalId_idx" ON "insurance_policies"("patientId", "hospitalId");

-- CreateIndex
CREATE INDEX "insurance_policies_policyNumber_idx" ON "insurance_policies"("policyNumber");

-- CreateIndex
CREATE INDEX "insurance_policies_memberId_idx" ON "insurance_policies"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "nhcx_preauths_preAuthNumber_key" ON "nhcx_preauths"("preAuthNumber");

-- CreateIndex
CREATE INDEX "nhcx_preauths_hospitalId_status_idx" ON "nhcx_preauths"("hospitalId", "status");

-- CreateIndex
CREATE INDEX "nhcx_preauths_patientId_idx" ON "nhcx_preauths"("patientId");

-- CreateIndex
CREATE INDEX "nhcx_preauths_admissionId_idx" ON "nhcx_preauths"("admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "nhcx_claims_claimNumber_key" ON "nhcx_claims"("claimNumber");

-- CreateIndex
CREATE INDEX "nhcx_claims_hospitalId_status_idx" ON "nhcx_claims"("hospitalId", "status");

-- CreateIndex
CREATE INDEX "nhcx_claims_patientId_idx" ON "nhcx_claims"("patientId");

-- CreateIndex
CREATE INDEX "nhcx_claims_admissionId_idx" ON "nhcx_claims"("admissionId");

-- CreateIndex
CREATE INDEX "nhcx_transactions_requestId_idx" ON "nhcx_transactions"("requestId");

-- CreateIndex
CREATE INDEX "nhcx_transactions_correlationId_idx" ON "nhcx_transactions"("correlationId");

-- CreateIndex
CREATE INDEX "nhcx_transactions_transactionId_idx" ON "nhcx_transactions"("transactionId");

-- CreateIndex
CREATE INDEX "nhcx_transactions_apiCallId_idx" ON "nhcx_transactions"("apiCallId");

-- CreateIndex
CREATE INDEX "nhcx_transactions_participantId_status_idx" ON "nhcx_transactions"("participantId", "status");

-- CreateIndex
CREATE INDEX "nhcx_transactions_createdAt_idx" ON "nhcx_transactions"("createdAt");

-- AddForeignKey
ALTER TABLE "nhcx_participants" ADD CONSTRAINT "nhcx_participants_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_certificates" ADD CONSTRAINT "nhcx_certificates_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "nhcx_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_preauths" ADD CONSTRAINT "nhcx_preauths_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_preauths" ADD CONSTRAINT "nhcx_preauths_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_preauths" ADD CONSTRAINT "nhcx_preauths_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_preauths" ADD CONSTRAINT "nhcx_preauths_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_claims" ADD CONSTRAINT "nhcx_claims_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_claims" ADD CONSTRAINT "nhcx_claims_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_claims" ADD CONSTRAINT "nhcx_claims_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_claims" ADD CONSTRAINT "nhcx_claims_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_claims" ADD CONSTRAINT "nhcx_claims_preAuthId_fkey" FOREIGN KEY ("preAuthId") REFERENCES "nhcx_preauths"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_transactions" ADD CONSTRAINT "nhcx_transactions_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "nhcx_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_transactions" ADD CONSTRAINT "nhcx_transactions_preAuthId_fkey" FOREIGN KEY ("preAuthId") REFERENCES "nhcx_preauths"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nhcx_transactions" ADD CONSTRAINT "nhcx_transactions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "nhcx_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;
