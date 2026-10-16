/**
 * Error surface for `@arki/http`.
 *
 * Two families, mirroring the DOT diagnostics doctrine:
 *
 *  - {@link HttpConfigError} — composition/lifecycle failures (duplicate
 *    routes, listen failures, drain timeouts). Thrown from `boot`/`start`/
 *    `stop`; the kernel wraps them and their `code`/`remediation`/`docsUrl`
 *    propagate into `app.diagnostics.issues`.
 *  - {@link HttpError} — per-request failures. Thrown from handlers,
 *    derivers, or validation; serialized onto the wire as the coded
 *    envelope `{ error: { code, message, remediation?, docsUrl?, data? } }`.
 *    A handler that returns an `@arki/failure` failure gets the same
 *    envelope, with the failure's status, code, message and data.
 *
 * Every code is stable API. Match on codes, never parse messages.
 */

/**
 * Stable error codes for `@arki/http`. `E0NN` codes surface through the
 * DOT lifecycle (boot/start/stop failures); `E4xx`/`E5xx` codes surface
 * on the wire in the error envelope. The digits of a wire code name the
 * kind of failure; they are not always the HTTP status (`E510` and `E511`
 * answer 500).
 */
export const HTTP_ERROR_CODES = {
  /** `start` could not bind the port. */
  listenFailed: 'ARKI_HTTP_E001',
  /** Two bindings claim the same method + path. */
  duplicateRoute: 'ARKI_HTTP_E002',
  /** `stop` exceeded `drainTimeoutMs` with requests still in flight. */
  drainTimeout: 'ARKI_HTTP_E005',
  /** A mount path is malformed. */
  invalidMount: 'ARKI_HTTP_E006',
  /** A deriver key duplicates an earlier deriver or a base context key. */
  duplicateDeriverKey: 'ARKI_HTTP_E007',
  /** A DOT HTTP action carries missing or incompatible projection metadata. */
  invalidActionMeta: 'ARKI_HTTP_E009',
  /** A route contract is inconsistent: params, headers, or responses do not fit its path or each other. Thrown at declaration. */
  invalidContract: 'ARKI_HTTP_E011',
  /** A webhook scheme has no secrets, an empty secret, or a secret it cannot decode. Thrown when the scheme is created. */
  invalidWebhookScheme: 'ARKI_HTTP_E012',
  /** A contract schema cannot describe itself as JSON Schema (OpenAPI, manifest). Thrown by `contractMeta`/`toOpenApi`. */
  noJsonSchema: 'ARKI_HTTP_E013',
  /** Request validation failed (params/headers/query/body) or the body is not valid JSON. */
  badRequest: 'ARKI_HTTP_E400',
  /** A route that needs an idempotency key got none, or an unusable one. Answers 400. */
  idempotencyKeyMissing: 'ARKI_HTTP_E410',
  /** An idempotency key was reused with a different method, path, query or body. Answers 422. */
  idempotencyKeyReused: 'ARKI_HTTP_E411',
  /** A request with this idempotency key is still running. Answers 409 with `retry-after`. */
  idempotencyInProgress: 'ARKI_HTTP_E412',
  /** A request body is larger than the route allows. Answers 413. */
  payloadTooLarge: 'ARKI_HTTP_E413',
  /** A client call ran past its `timeoutMs`. Thrown by `@arki/http/client`; never sent on the wire. */
  requestTimeout: 'ARKI_HTTP_E408',
  /** A webhook's signature headers are missing or malformed. Answers 401. */
  webhookMalformed: 'ARKI_HTTP_E420',
  /** No webhook signature matches the body with any of the secrets. Answers 401. */
  webhookSignatureMismatch: 'ARKI_HTTP_E421',
  /** A webhook's signed time is too far from now: a replay, or a clock far off. Answers 401. */
  webhookStale: 'ARKI_HTTP_E422',
  /** A deriver rejected the request's credentials. */
  unauthorized: 'ARKI_HTTP_E401',
  /** A deriver rejected the request's permissions. */
  forbidden: 'ARKI_HTTP_E403',
  /** No route matches the request. */
  notFound: 'ARKI_HTTP_E404',
  /** Handler crash or output-schema violation. */
  internal: 'ARKI_HTTP_E500',
  /** A handler returned a `Response` without `output: raw()`, or a value from a `raw()` route. Answers 500. */
  rawResponseMismatch: 'ARKI_HTTP_E510',
  /** A handler's result does not fit its contract: undeclared status, malformed `reply`, or a value on a no-output route. Answers 500. */
  invalidResponse: 'ARKI_HTTP_E511',
} as const;

const docsUrlFor = (code: string): string => `https://arki.dev/http/errors/${code.toLowerCase().replaceAll('_', '-')}`;

/**
 * A per-request failure with an HTTP status and a stable code. Throw from
 * a handler or deriver to short-circuit into the wire envelope:
 *
 * ```ts
 * throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
 * ```
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remediation: string | undefined;
  readonly docsUrl: string | undefined;
  /** Extra response headers — e.g. `www-authenticate` on a 401, `retry-after` on a 429. */
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      readonly remediation?: string;
      readonly docsUrl?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.remediation = options.remediation;
    this.docsUrl = options.docsUrl ?? docsUrlFor(code);
    this.headers = options.headers;
  }
}

/**
 * A composition or lifecycle failure. Carries the same code/remediation/
 * docsUrl fields the DOT kernel propagates into diagnostics when a hook
 * throws.
 */
export class HttpConfigError extends Error {
  readonly code: string;
  readonly remediation: string;
  readonly docsUrl: string;

  constructor(fields: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
    readonly docsUrl?: string;
    readonly cause?: unknown;
  }) {
    super(fields.message, fields.cause === undefined ? {} : { cause: fields.cause });
    this.name = 'HttpConfigError';
    this.code = fields.code;
    this.remediation = fields.remediation;
    this.docsUrl = fields.docsUrl ?? docsUrlFor(fields.code);
  }
}

/** The wire error envelope. Stable shape — agents parse this. */
export type HttpErrorEnvelope = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
    readonly docsUrl?: string;
    /** The failure's data, when a handler returned an `@arki/failure` failure that carries some. */
    readonly data?: unknown;
  };
};

/**
 * Message for an unexpected (non-{@link HttpError}) failure: full detail
 * in development, redacted in production — internals never leak onto the
 * wire of a deployed app.
 */
export function describeInternalError(error: unknown): string {
  if (process.env.NODE_ENV === 'production') return 'internal error';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map any thrown value to its wire envelope: {@link HttpError} keeps its
 * status and fields; everything else is a redacted-in-production 500.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message, {
      ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
      ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
      ...(error.headers === undefined ? {} : { headers: error.headers }),
    });
  }
  return errorResponse(500, HTTP_ERROR_CODES.internal, describeInternalError(error));
}

/** Build the envelope `Response` for a coded failure. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  options: {
    readonly remediation?: string;
    readonly docsUrl?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly data?: unknown;
  } = {},
): Response {
  const envelope: HttpErrorEnvelope = {
    error: {
      code,
      message,
      ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
      ...(options.docsUrl === undefined ? {} : { docsUrl: options.docsUrl }),
      ...(options.data === undefined ? {} : { data: options.data }),
    },
  };
  return Response.json(envelope, { status, ...(options.headers === undefined ? {} : { headers: options.headers }) });
}
