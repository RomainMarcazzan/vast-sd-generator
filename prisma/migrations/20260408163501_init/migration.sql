-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROVISIONING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "width" INTEGER NOT NULL DEFAULT 512,
    "height" INTEGER NOT NULL DEFAULT 512,
    "steps" INTEGER NOT NULL DEFAULT 20,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "vastInstanceId" TEXT,
    "errorMessage" TEXT,
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

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedImage_filename_key" ON "GeneratedImage"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedImage_jobId_key" ON "GeneratedImage"("jobId");

-- AddForeignKey
ALTER TABLE "GeneratedImage" ADD CONSTRAINT "GeneratedImage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
