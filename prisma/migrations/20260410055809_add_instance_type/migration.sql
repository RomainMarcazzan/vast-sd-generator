-- CreateEnum
CREATE TYPE "InstanceType" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable
ALTER TABLE "VastInstance" ADD COLUMN     "type" "InstanceType" NOT NULL DEFAULT 'IMAGE';
