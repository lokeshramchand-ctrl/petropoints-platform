/** Typed domain errors. The HTTP layer maps `status` + `code` into the public error envelope. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You are not allowed to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, 422, details);
  }
}

export class InsufficientPointsError extends DomainError {
  constructor(available: number, requested: number) {
    super('INSUFFICIENT_POINTS', `Customer has ${available} points, ${requested} requested`, 409, {
      available,
      requested,
    });
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body',
      422,
    );
  }
}

export class AlreadyReversedError extends DomainError {
  constructor() {
    super('ALREADY_REVERSED', 'This transaction has already been reversed', 409);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}
