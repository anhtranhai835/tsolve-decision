import { APIPromise, requestIdFrom } from "./api-promise.ts";
import { copyAssetBytes, encodeAssets, MultipartBody, serializeRequest } from "./assets.ts";
import {
  byteLength,
  compressBody,
  MIN_COMPRESSED_BODY_BYTES,
  resolveCompression,
} from "./compression.ts";
import { ENV, fromCodeOrEnv, readEnv } from "./env.ts";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  DecisionError,
} from "./errors.ts";
import {
  consoleLogger,
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  redactHeaders,
  withLevel,
} from "./logging.ts";
import { validateQuestions } from "./questions.ts";
import { Models } from "./resources/models.ts";
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  isRetryableStatus,
  retryDelayMs,
  sleep,
} from "./retry.ts";
import { describeRuntime, isBrowser } from "./runtime.ts";
import type {
  Compression,
  Fetch,
  Logger,
  LogLevel,
  Questions,
  RequestOptions,
  RetryPolicy,
  SystemOneRequest,
  SystemOneResult,
  DecisionClientConfig,
} from "./types.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_MODEL = "tsolve-decision";

// ---------------------------------------------------------------------------
// Construction-time checks
// ---------------------------------------------------------------------------

const missingApiKey = (): never => {
  throw new DecisionError(
    `No API key was provided. Pass \`apiKey\` to the DecisionClient constructor or set the ${ENV.apiKey} environment variable.`,
  );
};

const missingFetch = (): never => {
  throw new DecisionError(
    "No global `fetch` is available in this runtime. Pass a `fetch` implementation to the DecisionClient constructor.",
  );
};

const refuseBrowser = (): never => {
  throw new DecisionError(
    "DecisionClient is running in a browser, which would expose your API key to anyone using the page. " +
      "Call the API from a server instead, or pass `dangerouslyAllowBrowser: true` if you understand the risk.",
  );
};

/** Call global `fetch` with its required receiver in browsers. */
const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

const assertNonNegativeInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new DecisionError(`\`${name}\` must be a non-negative integer, got ${String(value)}.`);
  }
  return value;
};

const assertPositiveMs = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DecisionError(
      `\`${name}\` must be a positive number of milliseconds, got ${String(value)}.`,
    );
  }
  return value;
};

const assertNonNegativeMs = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new DecisionError(
      `\`${name}\` must be a non-negative number of milliseconds, got ${String(value)}.`,
    );
  }
  return value;
};

const assertFraction = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionError(`\`${name}\` must be between 0 and 1, got ${String(value)}.`);
  }
  return value;
};

const assertStatusSet = (name: string, statuses: ReadonlySet<number>): ReadonlySet<number> => {
  for (const status of statuses) {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new DecisionError(`\`${name}\` must contain HTTP status codes, got ${String(status)}.`);
    }
  }
  return statuses;
};

/** Merge and validate retry overrides, copying the status set to isolate later mutations. */
const resolveRetryPolicy = (
  base: RetryPolicy,
  overrides: Partial<RetryPolicy> | undefined,
): RetryPolicy => {
  const o = overrides ?? {};
  return {
    maxRetries:
      o.maxRetries === undefined
        ? base.maxRetries
        : assertNonNegativeInteger("retry.maxRetries", o.maxRetries),
    backoffInitialMs:
      o.backoffInitialMs === undefined
        ? base.backoffInitialMs
        : assertNonNegativeMs("retry.backoffInitialMs", o.backoffInitialMs),
    backoffMaxMs:
      o.backoffMaxMs === undefined
        ? base.backoffMaxMs
        : assertNonNegativeMs("retry.backoffMaxMs", o.backoffMaxMs),
    backoffJitter:
      o.backoffJitter === undefined
        ? base.backoffJitter
        : assertFraction("retry.backoffJitter", o.backoffJitter),
    httpStatuses: new Set(
      o.httpStatuses === undefined
        ? base.httpStatuses
        : assertStatusSet("retry.httpStatuses", o.httpStatuses),
    ),
    respectRetryAfter: o.respectRetryAfter ?? base.respectRetryAfter,
    maxRetryAfterMs:
      o.maxRetryAfterMs === undefined
        ? base.maxRetryAfterMs
        : assertNonNegativeMs("retry.maxRetryAfterMs", o.maxRetryAfterMs),
    apiConnectionError: o.apiConnectionError ?? base.apiConnectionError,
    apiTimeoutError: o.apiTimeoutError ?? base.apiTimeoutError,
  };
};

/** Whether the policy retries a connection error or timeout. */
const isRetryableError = (err: unknown, policy: RetryPolicy): boolean => {
  if (err instanceof APITimeoutError) return policy.apiTimeoutError;
  if (err instanceof APIConnectionError) return policy.apiConnectionError;
  return false;
};

/** Resolve and validate the log level from configuration or the environment. */
const resolveLogLevel = (fromCode: LogLevel | undefined): LogLevel => {
  if (fromCode !== undefined) return parseLogLevel(fromCode, "the `logLevel` option");
  const fromEnv = readEnv(ENV.logLevel);
  if (fromEnv !== undefined) return parseLogLevel(fromEnv, ENV.logLevel);
  return DEFAULT_LOG_LEVEL;
};

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

/** Last value wins regardless of casing; undefined removes a protected header. */
const mergeHeaders = (
  ...sources: Readonly<Record<string, string | undefined>>[]
): Record<string, string> => {
  const entries = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) entries.delete(name.toLowerCase());
      else entries.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(entries.values());
};

/** Drain a clone so the original response retains its metadata and a readable, buffered body. */
const bufferResponse = async (response: Response, signal: AbortSignal): Promise<void> => {
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  // Node.js 22's fetch cancels an unlocked response body on abort and leaves the rejection
  // unhandled, so the original body is locked while the clone is read.
  const original = response.body?.getReader();
  const cancel = (): void => {
    // Cancel both tee branches without waiting for an underlying source to acknowledge it.
    void reader.cancel(signal.reason).catch(() => {});
    void original?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    while (!(await reader.read()).done) {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
    original?.releaseLock();
  }
};

/**
 * Call `start` and settle with its result, or reject with the signal's reason when the signal
 * aborts first. `start` isn't called if the signal has already aborted.
 */
const untilAborted = <T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (signal === undefined) return start();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    start().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Method = "GET" | "POST";

/**
 * Per-call transport options with an optional JSON body or `MultipartBody`, or a function called
 * at send time that returns a promise for one.
 */
export interface RawRequestOptions extends RequestOptions {
  body?: unknown;
}

/** Internal transport interface used by API resources. */
export interface Transport {
  request<T>(method: "GET" | "POST", path: string, options?: RawRequestOptions): APIPromise<T>;
  readonly defaultModel: string;
}

interface ResolvedRequest {
  method: Method;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
  timeout: number;
  retry: RetryPolicy;
}

/** Runtime description cached for the process lifetime. */
const RUNTIME = describeRuntime();

/** An `APIPromise` rejected with `err`, for failures found before a request is sent. */
const rejectedAPIPromise = <T>(err: unknown): APIPromise<T> => {
  const response = Promise.reject(err);
  return new APIPromise<T>(response, () => response as Promise<T>);
};

/** Client for the T-Solve decision server. */
export class DecisionClient {
  /** API key excluded from serialization and public properties. */
  readonly #apiKey: string;
  /** API root with trailing slashes removed. */
  readonly baseURL: string;
  /** Model used when a request omits `model`. */
  readonly defaultModel: string;
  /** Configured log verbosity. */
  readonly logLevel: LogLevel;
  /** The configured logger, filtered to `logLevel`. */
  readonly logger: Logger;
  /** Retry settings with constructor overrides applied. */
  readonly retry: RetryPolicy;
  /** Timeout per attempt in milliseconds. */
  readonly timeout: number;
  /** Additional headers sent with each request. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
  /** Request body compression, or `false` when bodies are sent uncompressed. */
  readonly compression: Compression;
  /** HTTP fetch implementation. */
  readonly fetch: Fetch;

  /** The models available to the account. */
  readonly models: Models;

  #requestCount = 0;

  /**
   * Create a client for the T-Solve decision server.
   *
   * Explicit options take precedence over environment variables, then SDK defaults.
   * Empty or whitespace-only environment values are ignored.
   *
   * @throws {DecisionError} The API key is missing, configuration is invalid, the runtime is
   *   unsupported, or the runtime lacks the requested compression.
   */
  constructor(config: DecisionClientConfig = {}) {
    if (isBrowser() && !config.dangerouslyAllowBrowser) refuseBrowser();

    this.#apiKey = fromCodeOrEnv(config.apiKey, ENV.apiKey) ?? missingApiKey();
    this.baseURL = stripTrailingSlashes(
      fromCodeOrEnv(config.baseURL, ENV.baseURL) ?? DEFAULT_BASE_URL,
    );
    this.defaultModel = fromCodeOrEnv(config.defaultModel, ENV.defaultModel) ?? DEFAULT_MODEL;
    this.logLevel = resolveLogLevel(config.logLevel);
    this.logger = withLevel(config.logger ?? consoleLogger, this.logLevel);
    this.retry = resolveRetryPolicy(DEFAULT_RETRY_POLICY, config.retry);
    this.timeout = assertPositiveMs("timeout", config.timeout ?? DEFAULT_TIMEOUT_MS);
    this.defaultHeaders = { ...config.defaultHeaders };
    this.compression = resolveCompression(config.compression);

    if (config.fetch === undefined && typeof globalThis.fetch !== "function") missingFetch();
    this.fetch = config.fetch ?? defaultFetch;

    const transport: Transport = {
      request: (method, path, options) => this.#request(method, path, options),
      defaultModel: this.defaultModel,
    };
    this.models = new Models(transport);
  }

  /**
   * Answer named questions about text, structured state, or assets.
   *
   * @param request - State, questions, an optional model override, and optional assets.
   *   Assets in `state`, question content, or `withAssets` text are sent under their references.
   * @param options - Per-call timeout, retry, headers, and cancellation settings.
   * @returns Answers typed by question name and criteria, with model and token usage. Every
   *   failure below rejects the returned promise; the call itself doesn't throw.
   * @throws {DecisionError} State is `null` or omitted, questions are empty, score criteria are not
   *   a list of at least two entries, choice criteria are not a nonempty map, a noul question has
   *   neither instructions nor a described outcome, a string holds the reference of an asset not
   *   attached to the request, a name in `assets` doesn't appear in the request, or a `Blob`
   *   asset can't be read.
   * @throws {APIError} The server returns a non-2xx response after retries.
   * @throws {APIConnectionError} The request cannot connect or times out after retries.
   * @throws {APIUserAbortError} The caller aborts the request.
   *
   * @example
   * ```ts
   * const { answers } = await client.systemOne({
   *   state: "I was charged twice. Please help.",
   *   questions: { billing: noul("Is this about billing?") },
   * });
   * console.log(answers.billing.noul);
   * ```
   */
  systemOne<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: RequestOptions = {},
  ): APIPromise<SystemOneResult<Q>> {
    let body: unknown;
    try {
      if (request.state == null) throw new DecisionError("State is required.");
      validateQuestions(request.questions);
      const { assets, ...rest } = request;
      // Serialized now, so changes to the request after this call don't change what is sent.
      const { json, assets: sent } = serializeRequest(
        { ...rest, model: request.model ?? this.defaultModel },
        assets,
      );
      const payload: object = JSON.parse(json);
      const copied = sent === undefined ? undefined : copyAssetBytes(sent);
      body = copied === undefined ? payload : () => encodeAssets(payload, copied);
    } catch (err) {
      return rejectedAPIPromise(err);
    }

    return this.#request<SystemOneResult<Q>>("POST", "/v1/systemone", {
      ...options,
      body,
    });
  }

  /** Send a request and parse its response body. */
  #request<T>(method: Method, path: string, options: RawRequestOptions = {}): APIPromise<T> {
    let resolved: ResolvedRequest;
    try {
      resolved = {
        method,
        path,
        body: options.body,
        headers: mergeHeaders(this.defaultHeaders, options.headers ?? {}),
        signal: options.signal,
        timeout:
          options.timeout === undefined
            ? this.timeout
            : assertPositiveMs("timeout", options.timeout),
        retry: resolveRetryPolicy(this.retry, options.retry),
      };
    } catch (err) {
      return rejectedAPIPromise(err);
    }
    // Numbered so concurrent requests, and the attempts within one, can be told apart in the logs.
    const tag = `#${++this.#requestCount} ${method} ${path}`;

    return new APIPromise<T>(this.fetchWithRetries(tag, resolved), async (res) => {
      const parsed = await parseBody(res);
      this.logger.debug(`${tag} <- body`, parsed);
      return parsed as T;
    });
  }

  /** Retry eligible failures, logging attempt summaries at `info` and headers and bodies at `debug`. */
  private async fetchWithRetries(tag: string, req: ResolvedRequest): Promise<Response> {
    const url = `${this.baseURL}${req.path}`;
    let resolved = req.body;
    if (typeof resolved === "function") {
      try {
        resolved = await untilAborted(resolved as () => Promise<unknown>, req.signal);
      } catch (err) {
        if (!req.signal?.aborted) throw err;
        this.logger.info(`${tag} aborted by caller while reading assets`);
        throw new APIUserAbortError(undefined, { cause: err });
      }
    }
    const multipart = resolved instanceof MultipartBody ? resolved : undefined;
    const payload = multipart === undefined ? resolved : multipart.payload;
    const encoded =
      multipart?.content ?? (payload === undefined ? undefined : JSON.stringify(payload));
    const encoding =
      encoded === undefined || byteLength(encoded) < MIN_COMPRESSED_BODY_BYTES
        ? false
        : this.compression;
    // Compressed once and sent as-is on every attempt; the logs show the uncompressed payload.
    let body: string | Blob | Uint8Array<ArrayBuffer> | undefined = encoded;
    if (encoded !== undefined && encoding !== false) {
      try {
        body = await untilAborted(() => compressBody(encoded), req.signal);
      } catch (err) {
        if (!req.signal?.aborted) throw err;
        this.logger.info(`${tag} aborted by caller while compressing the body`);
        throw new APIUserAbortError(undefined, { cause: err });
      }
    }
    // User-supplied headers go first so they can't clobber auth, the content type, or the encoding.
    const headers = mergeHeaders(req.headers, {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `tsolve-decision-sdk/${VERSION}`,
      "X-TSolve-Decision-SDK": `tsolve-decision-sdk/${VERSION}`,
      "X-TSolve-Decision-Runtime": RUNTIME,
      "Content-Type":
        multipart?.contentType ?? (body === undefined ? undefined : "application/json"),
      "Content-Encoding": encoding === false ? undefined : encoding,
      "X-TSolve-Decision-Retry-Count": undefined,
    });

    for (let attempt = 0; ; attempt++) {
      const retriesLeft = req.retry.maxRetries - attempt;
      const attemptHeaders =
        attempt === 0 ? headers : { ...headers, "X-TSolve-Decision-Retry-Count": String(attempt) };
      this.logger.debug(`${tag} -> ${url}`, {
        headers: redactHeaders(attemptHeaders),
        body: payload,
      });

      const started = Date.now();
      let res: Response;
      try {
        res = await this.attempt(
          tag,
          url,
          { method: req.method, headers: attemptHeaders, body },
          req,
        );
      } catch (err) {
        if (err instanceof APIUserAbortError || retriesLeft <= 0) throw err;
        if (!isRetryableError(err, req.retry)) throw err;
        await this.backOff(tag, attempt, retriesLeft, (err as Error).message, undefined, req);
        continue;
      }

      const requestId = requestIdFrom(res.headers);
      this.logger.info(
        `${tag} <- ${res.status} in ${Date.now() - started}ms${requestId ? ` (request ${requestId})` : ""}`,
      );
      if (res.ok) return res;

      const errorBody = await parseBody(res);
      this.logger.debug(`${tag} <- error body`, errorBody);
      const error = APIError.fromResponse(res.status, errorBody, res.headers);
      if (retriesLeft <= 0 || !isRetryableStatus(res.status, req.retry)) throw error;
      await this.backOff(tag, attempt, retriesLeft, `${res.status}`, res.headers, req);
    }
  }

  /**
   * One HTTP round trip, including body delivery, with a timeout. The caller's signal and our
   * timer both abort the same controller; we check which fired to choose the error class.
   */
  private async attempt(
    tag: string,
    url: string,
    init: {
      method: Method;
      headers: Record<string, string>;
      body: string | Blob | Uint8Array<ArrayBuffer> | undefined;
    },
    { signal, timeout }: ResolvedRequest,
  ): Promise<Response> {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    const started = Date.now();
    const elapsed = (): string => `${Date.now() - started}ms`;
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      await bufferResponse(response, controller.signal);
      return response;
    } catch (err) {
      if (signal?.aborted) {
        this.logger.info(`${tag} aborted by caller after ${elapsed()}`);
        throw new APIUserAbortError(undefined, { cause: err });
      }
      if (timedOut) {
        this.logger.info(`${tag} timed out after ${elapsed()}`);
        throw new APITimeoutError(timeout, { cause: err });
      }
      this.logger.info(`${tag} connection error after ${elapsed()}`, err);
      throw new APIConnectionError(
        err instanceof Error ? `Connection error: ${err.message}` : undefined,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Wait before retrying; caller cancellation throws `APIUserAbortError`. */
  private async backOff(
    tag: string,
    attempt: number,
    retriesLeft: number,
    reason: string,
    headers: Headers | undefined,
    { retry, signal }: ResolvedRequest,
  ): Promise<void> {
    const delay = retryDelayMs(attempt, headers, retry);
    const nth = attempt + 1;
    const total = attempt + retriesLeft;
    this.logger.info(`${tag} retrying in ${delay}ms (retry ${nth}/${total}) after ${reason}`);
    try {
      await sleep(delay, signal);
    } catch (err) {
      this.logger.info(`${tag} aborted by caller while waiting to retry`);
      throw new APIUserAbortError(undefined, { cause: err });
    }
  }
}

const parseBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text.length === 0) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  // Be lenient: servers and proxies don't always set content-type.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
