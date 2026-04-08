import { execSync } from 'node:child_process';

export default function setup() {
  console.log('Setting up test database...');
  try {
    execSync('npx prisma migrate deploy', {
      env: process.env,
      stdio: 'inherit',
    });
    console.log('Migrations applied successfully');
  } catch (error) {
    console.error('Failed to apply migrations:', error);
    throw error;
  }
}
