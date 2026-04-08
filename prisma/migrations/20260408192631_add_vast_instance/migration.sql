-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('RUNNING', 'DESTROYED');

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "instanceId" TEXT;

-- CreateTable
CREATE TABLE "VastInstance" (
    "id" TEXT NOT NULL,
    "vastInstanceId" TEXT NOT NULL,
    "status" "InstanceStatus" NOT NULL DEFAULT 'RUNNING',
    "host" TEXT,
    "port" TEXT,
    "gpuName" TEXT,
    "costPerHour" DOUBLE PRECISION,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VastInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VastInstance_vastInstanceId_key" ON "VastInstance"("vastInstanceId");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "VastInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
