import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './config/env.js';
import { defaultHook, onErrorHandler } from './lib/error-handler.js';
import { metricsHandler, metricsMiddleware } from './lib/metrics.js';
import generate from './routes/generate/index.js';
import images from './routes/images/index.js';
import instances from './routes/instances/index.js';
import jobs from './routes/jobs/index.js';
import videos from './routes/videos/index.js';

// Define types for environment bindings and context variables
type Bindings = {
  DATABASE_URL: string;
  PORT: string;
  NODE_ENV: string;
};

type Variables = {
  requestId?: string;
  startTime?: number;
};

const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Variables }>({ defaultHook });

// Request ID middleware for debugging
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// Conditional logger middleware (noisy in prod/test)
if (env.NODE_ENV !== 'test') {
  app.use('*', logger());
}

// CORS middleware - configured from environment
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposeHeaders: ['Content-Length', 'Content-Type'],
    credentials: true,
  })
);

// 404 handler for unmatched routes
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Centralized error handling
app.onError(onErrorHandler);

// Health check endpoint
app.get('/health', (c) => c.text('OK', 200));

// Metrics middleware - collecte les métriques pour toutes les routes
app.use('*', metricsMiddleware);

// Metrics endpoint pour Prometheus/VictoriaMetrics (non documenté dans Swagger)
app.get('/metrics', async (c) => {
  const response = await metricsHandler();
  return c.newResponse(response.body, response);
});

// API routes
app.route('/api/v1/generate', generate);
app.route('/api/v1/jobs', jobs);
app.route('/api/v1/images', images);
app.route('/api/v1/instances', instances);
app.route('/api/v1/videos', videos);

// Protect Swagger UI with Basic Auth
const swaggerAuth = basicAuth({ username: env.SWAGGER_USER, password: env.SWAGGER_PASSWORD });
app.use('/api/doc', swaggerAuth);
app.use('/api/swagger', swaggerAuth);

// OpenAPI documentation
app.doc('/api/doc', {
  openapi: '3.1.0',
  info: {
    version: '1.0.1',
    title: 'Stable Diffusion Generator API',
    description: 'Image generation API using Stable Diffusion via Vast.ai',
  },
  servers: [
    {
      url: env.SERVER_URL,
      description: 'Server',
    },
  ],
});

// Swagger UI documentation
app.get('/api/swagger', swaggerUI({ url: '/api/doc' }));

export default app;
