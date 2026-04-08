import { serve } from '@hono/node-server';
import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';

// Start server
serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
    console.log(`Environment: ${env.NODE_ENV}`);
    console.log(`API Documentation available at http://localhost:${info.port}/api/swagger`);
  }
);
