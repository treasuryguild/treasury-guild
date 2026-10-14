// Error classes shared by lib, API routes and (for instanceof checks on the
// wire shape) the client. Client-safe: no I/O, no server-only imports.
//
// HttpError subclasses carry the status the API layer should answer with;
// everything else is a plain Error subclass that the route wrapper maps.

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Extra JSON fields merged into the error body (e.g. { problems }). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, extra?: Record<string, unknown>) {
    super(400, message, extra);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Not authenticated") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, extra?: Record<string, unknown>) {
    super(409, message, { conflict: true, ...extra });
    this.name = "ConflictError";
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests. Please wait a moment and try again.") {
    super(429, message);
    this.name = "TooManyRequestsError";
  }
}

/**
 * An OAuth 2.1 error response of the agent API's authorization server: the
 * route wrapper renders it as `{ error: <code>, error_description }`, the
 * shape OAuth clients read (RFC 6749 §5.2).
 */
export class OAuthProtocolError extends HttpError {
  constructor(status: number, code: string, description: string) {
    super(status, code, { error_description: description });
    this.name = "OAuthProtocolError";
  }
}

/** User-facing validation failure raised inside lib (maps to 400). */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/** A third-party service (Koios, GitHub, Pinata) failed (maps to 502). */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Internal state that should be impossible (DB error, mismatched script). */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

/** Missing/invalid environment configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  return err instanceof Error ? err.message : fallback;
}
