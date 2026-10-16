import {
  ArgumentMetadata,
  ArgumentsHost,
  Catch,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  PipeTransform,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { idempotencyKey } from '@petropoints/contracts';
import { can, type Permission, type Principal } from '@petropoints/rbac';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodSchema } from 'zod';
import { AuthService } from '../auth/auth.service';
import { DomainError, ForbiddenError, UnauthorizedError, ValidationError } from '../common/errors';
import { PG, pgCode } from '../db/db';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/* ---------------- validation ---------------- */

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown, _meta: ArgumentMetadata): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new ValidationError(
        'Request validation failed',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }
}

/* ---------------- auth ---------------- */

const PUBLIC = 'isPublic';
const PERMISSION = 'requiredPermission';
export const Public = () => SetMetadata(PUBLIC, true);
export const Requires = (permission: Permission) => SetMetadata(PERMISSION, permission);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal =>
    ctx.switchToHttp().getRequest<FastifyRequest>().principal as Principal,
);

/** Reads and validates the Idempotency-Key header that every money-moving command must carry. */
export const IdemKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<FastifyRequest>().headers['idempotency-key'];
  const parsed = idempotencyKey.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new ValidationError('A valid Idempotency-Key header (16-128 chars) is required');
  }
  return parsed.data;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError('Missing bearer token');
    req.principal = await this.auth.verifyAccessToken(header.slice(7));

    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    if (needed && !can(req.principal.role, needed)) throw new ForbiddenError();
    return true;
  }
}

/* ---------------- errors ---------------- */

/** Every error leaves the API in one shape and never leaks stack traces or SQL. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();

    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof DomainError) {
      ({ status, code, message, details } = exception);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
      message = exception.message;
    } else if (pgCode(exception) === PG.CHECK_VIOLATION) {
      status = 409;
      code = 'CONSTRAINT_VIOLATION';
      message = 'The operation violates a data integrity rule';
    }

    if (status >= 500) req.log.error({ err: exception }, 'unhandled error');

    void reply.status(status).send({ error: { code, message, requestId: req.id, details } });
  }
}
