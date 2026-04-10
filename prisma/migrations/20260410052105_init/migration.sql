-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROVISIONING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('PROVISIONING', 'RUNNING', 'DESTROYED');

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "width" INTEGER NOT NULL DEFAULT 1024,
    "height" INTEGER NOT NULL DEFAULT 1024,
    "steps" INTEGER NOT NULL DEFAULT 20,
    "cfgScale" DOUBLE PRECISION NOT NULL DEFAULT 7,
    "sampler" TEXT NOT NULL DEFAULT 'euler',
    "scheduler" TEXT NOT NULL DEFAULT 'normal',
    "seed" BIGINT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "vastInstanceId" TEXT,
    "errorMessage" TEXT,
    "instanceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedImage" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VastInstance" (
    "id" TEXT NOT NULL,
    "vastInstanceId" TEXT NOT NULL,
    "status" "InstanceStatus" NOT NULL DEFAULT 'PROVISIONING',
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
CREATE UNIQUE INDEX "GeneratedImage_filename_key" ON "GeneratedImage"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedImage_jobId_key" ON "GeneratedImage"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "VastInstance_vastInstanceId_key" ON "VastInstance"("vastInstanceId");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "VastInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedImage" ADD CONSTRAINT "GeneratedImage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
