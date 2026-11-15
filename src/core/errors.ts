export type ErrorCode =
  | 'not_found'
  | 'validation'
  | 'unprocessable'
  | 'conflict'
  | 'unauthorized'
  | 'not_implemented'
  | 'precondition_failed'
  | 'upstream'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  not_found: 404,
  validation: 400,
  unprocessable: 422,
  conflict: 409,
  unauthorized: 401,
  not_implemented: 501,
  precondition_failed: 412,
  upstream: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export class NotImplementedError extends AppError {
  constructor(what = 'not implemented') {
    super('not_implemented', what);
    this.name = 'NotImplementedError';
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);

export function notImplemented(what?: string): never {
  throw new NotImplementedError(what ? `${what}: not implemented` : 'not implemented');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
