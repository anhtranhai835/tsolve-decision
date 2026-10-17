// T-Solve Decision SDK: a modified copy of the official TypeSafe JS SDK
// (github.com/typesafe-ai/typesafe-sdk-js, commit b844cd1, MIT, see ./LICENSE).
// Changes: renamed TypeSafeClient/TypeSafeError to DecisionClient/DecisionError, env vars to
// TSOLVE_DECISION_*, default server to the local T-Solve decision server, imports end in .ts.
export { APIPromise, type WithResponse } from "./api-promise.ts";
export { Image, image, type TextWithAssets, withAssets } from "./assets.ts";
export { DecisionClient } from "./client.ts";
// Code written against the official SDK only changes its import path.
export { DecisionClient as TypeSafeClient } from "./client.ts";
export { DecisionError as TypeSafeError } from "./errors.ts";
export { ENV, type EnvVar } from "./env.ts";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  DecisionError,
  UnprocessableEntityError,
} from "./errors.ts";
export { LOG_LEVELS } from "./logging.ts";
export { box, choice, noul, score } from "./questions.ts";
export type { Models } from "./resources/models.ts";
export type * from "./types.ts";
export { VERSION } from "./version.ts";
