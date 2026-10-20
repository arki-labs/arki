/**
 * `@arki/http` — typed HTTP for ARKI.
 *
 * Route contracts as data ({@link route}), Standard-Schema-validated handlers bound in
 * a typed bundle builder ({@link routes}), request-scope derivers
 * ({@link derive}), SSE streaming, and deterministic OpenAPI generation
 * ({@link toOpenApi}).
 *
 * The framework-agnostic core lives here — {@link buildEngine} +
 * {@link listen} run a server without any framework. The DOT adapter (the
 * `http()` driver) lives at `@arki/http/dot`; the ambient request context —
 * a deliberate last resort — at `@arki/http/context`.
 */

export { route } from './contract.js';
export type {
  CheckResult,
  ContractLike,
  ErasedInput,
  FailureDefinitionLike,
  HttpMethod,
  ParamsOf,
  PathParams,
  ResponseSchemas,
  RouteContract,
  RouteDef,
  RouteFailure,
  RouteInput,
  SseContract,
  SseDef,
} from './contract.js';

export { codec, optional } from './wire.js';
export type { Codec, Field, Fields, FieldsOf, Optional, Reversible, ValueOf, Wire, WireValue } from './wire.js';

export { raw } from './raw.js';
export type { RawOutput } from './raw.js';

export { endpoints, reply, routes, rpcMount } from './bundle.js';
export type {
  EndpointsFeatureSlice,
  HandlerResult,
  MountBinding,
  MountMeta,
  MountPath,
  MountTransport,
  Reply,
  RouteBinding,
  RouteBundle,
  RouteBundleBuilder,
  RouteHandler,
  RpcActionMeta,
  RpcBinding,
  RpcMountContract,
  RpcMountHandlers,
  RpcMountOptions,
  SseHandler,
} from './bundle.js';

export { BASE_CTX_KEYS, derive } from './derive.js';
export type { BaseRequestCtx, Deriver, ErasedDeriver, FailureHeaders } from './derive.js';
export { requestId } from './ids.js';
export type { RequestId } from './ids.js';

export {
  describeInternalError,
  errorResponse,
  HTTP_ERROR_CODES,
  HttpConfigError,
  HttpError,
  orThrowHttp,
  toErrorResponse,
  UnsafeUrlError,
} from './error.js';
export type { HttpErrorEnvelope } from './error.js';

export { contractMeta, toOpenApi } from './openapi.js';
export type { OpenApiInfo, RouteMeta } from './openapi.js';

export { buildEngine, composeMiddleware } from './engine.js';
export type { Engine, HttpMiddleware } from './engine.js';

export { listen } from './listen.js';
export type { ListenHandle, ListenOptions } from './listen.js';

export {
  IDEMPOTENCY_FAILURES,
  HTTP_CLIENT_FAILURES,
  HTTP_SERVER_FAILURES,
  NetworkFailure,
  RequestCancelled,
  RequestTimeout,
  IdempotencyKeyRequired,
  IdempotencyKeyReused,
  IdempotencyInProgress,
  IdempotencyClaimUnconfirmed,
  IdempotencyWriteUnconfirmed,
  IdempotencyReleaseUnconfirmed,
  IdempotencyOwnershipLost,
  IdempotencyReplayInvalid,
  IdempotencyResponseUnavailable,
  IdempotencyRequestTooLarge,
  RESPONSE_CACHE_BEGIN_FAILURES,
  RESPONSE_CACHE_FINISH_FAILURES,
  RESPONSE_CACHE_ABANDON_FAILURES,
} from './failures.js';
export type { HttpClientFailure } from './failures.js';
