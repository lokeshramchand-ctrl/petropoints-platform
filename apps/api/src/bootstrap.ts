import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';
import type { Db } from './db/db';

export async function createApp(config: AppConfig, db: Db): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1024,
    trustProxy: config.NODE_ENV === 'production',
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
            ...(config.NODE_ENV === 'development' && {
              transport: { target: 'pino-pretty', options: { singleLine: true } },
            }),
          },
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, db),
    adapter,
    { bufferLogs: true, logger: config.NODE_ENV === 'test' ? false : undefined },
  );

  const fastify = app.getHttpAdapter().getInstance();

  await app.register(helmet as never, { contentSecurityPolicy: false });
  await app.register(cors as never, {
    origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : config.NODE_ENV !== 'production',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-request-id'],
  });
  await app.register(rateLimit as never, {
    global: true,
    max: config.NODE_ENV === 'test' ? 10_000 : 300,
    timeWindow: '1 minute',
    // Brute-force surface gets a much tighter bucket than the rest of the API
    keyGenerator: (req: { ip: string; url: string }) =>
      req.url.startsWith('/v1/auth/') ? `auth:${req.ip}` : req.ip,
    allowList: (req: { url: string }) => req.url.startsWith('/health'),
  });

  // Request id on every response, for support and log correlation.
  fastify.addHook(
    'onSend',
    (
      req: { id: string },
      reply: { header: (k: string, v: string) => void },
      _p: unknown,
      done: () => void,
    ) => {
      reply.header('x-request-id', req.id);
      done();
    },
  );

  // Prometheus metrics (scrape-only; the edge proxy must not expose /metrics publicly).
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  fastify.addHook(
    'onResponse',
    (
      req: { method: string; routeOptions?: { url?: string } },
      reply: { statusCode: number; elapsedTime: number },
      done: () => void,
    ) => {
      duration
        .labels(req.method, req.routeOptions?.url ?? 'unmatched', String(reply.statusCode))
        .observe(reply.elapsedTime / 1000);
      done();
    },
  );
  fastify.get(
    '/metrics',
    async (
      _req: unknown,
      reply: { header: (k: string, v: string) => { send: (b: string) => unknown } },
    ) => reply.header('content-type', registry.contentType).send(await registry.metrics()),
  );

  if (config.SWAGGER_ENABLED) {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const doc = new DocumentBuilder()
      .setTitle('PetroPoints API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  }

  app.enableShutdownHooks();
  return app;
}
