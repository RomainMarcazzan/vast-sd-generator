-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable
ALTER TABLE "GenerationJob" ADD COLUMN     "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE';

-- CreateTable
CREATE TABLE "GeneratedVideo" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL DEFAULT 16,
    "frames" INTEGER NOT NULL DEFAULT 81,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedVideo_filename_key" ON "GeneratedVideo"("filename");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedVideo_jobId_key" ON "GeneratedVideo"("jobId");

-- AddForeignKey
ALTER TABLE "GeneratedVideo" ADD CONSTRAINT "GeneratedVideo_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
