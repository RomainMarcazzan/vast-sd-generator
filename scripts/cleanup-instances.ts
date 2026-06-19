import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const result = await prisma.vastInstance.deleteMany({
    where: {
      status: { in: ['PROVISIONING', 'DESTROYED'] },
      OR: [
        { expiresAt: { lt: new Date() } },
        { status: 'DESTROYED' },
      ],
    },
  });

  console.log(`Cleaned up ${result.count} stale instances`);
}

main()
  .catch((e) => {
    console.error('Cleanup failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
