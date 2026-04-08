import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.string().default('3000').transform(Number),
  DATABASE_URL: z.string(),
  CORS_ORIGIN: z.string().default('*'),
  SWAGGER_USER: z.string().default('admin'),
  SWAGGER_PASSWORD: z.string().default('admin'),
  SERVER_URL: z.string().default('http://localhost:3000'),
  VAST_AI_API_KEY: z.string(),
  IMAGES_STORAGE_PATH: z.string().default('/data/images'),
});

export const env = envSchema.parse(process.env);
