import type { MiddlewareHandler } from 'hono';
import { Counter, Histogram, Registry } from 'prom-client';

// Création d'un registre dédié pour notre application
export const register = new Registry();

// Métrique : nombre total de requêtes HTTP
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requêtes HTTP',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Métrique : durée des requêtes HTTP
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Durée des requêtes HTTP en secondes',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Middleware de collecte des métriques
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = Date.now();

  await next();

  const duration = (Date.now() - start) / 1000;
  const method = c.req.method;
  const route = c.req.path;
  const statusCode = c.res.status.toString();

  // Incrémente le compteur de requêtes
  httpRequestsTotal.inc({ method, route, status_code: statusCode });

  // Enregistre la durée
  httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, duration);
};

// Route handler pour /metrics
export const metricsHandler = async () => {
  const metrics = await register.metrics();
  return new Response(metrics, {
    status: 200,
    headers: {
      'Content-Type': register.contentType,
    },
  });
};
