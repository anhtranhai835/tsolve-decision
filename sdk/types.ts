import type { Image, TextWithAssets } from "./assets.ts";

/** A JSON-compatible value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON-compatible value that may also hold assets, each written as its name in `assets`, or
 * else as its reference.
 */
export type ContentValue =
  | string
  | number
  | boolean
  | null
  | Asset
  | TextWithAssets
  | ContentValue[]
  | { [key: string]: ContentValue };

/**
 * Text, an asset, a JSON object or array, or `null` for instructions and criteria.
 *
 * Each asset in it is written as its name in `assets`, or else as its reference, and sent
 * with the request.
 */
export type EntryType =
  | string
  | Asset
  | TextWithAssets
  | { [key: string]: ContentValue }
  | ContentValue[]
  | null;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** A criterion description; `null` leaves the label undescribed. */
export type Description = EntryType;

/** A yes/no question with optional descriptions for either outcome. */
export interface NoulQuestion {
  type: "noul";
  /** The question as text, a JSON object, or an array; optional when `criteria` describes an outcome. */
  instructions?: EntryType;
  /** Descriptions of the yes and no outcomes; at least one is required when `instructions` is omitted or `null`. */
  criteria?: {
    /** Description of the yes outcome. */
    true?: EntryType;
    /** Description of the no outcome. */
    false?: EntryType;
  } | null;
}

/** Labels mapped to descriptions, or `null` for undescribed labels. */
export type ChoiceCriteria = {
  [label: string]: Description;
};

/** A question that selects between named alternatives. */
export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: "choice";
  /** The question as text, a JSON object, or an array; optional or `null`. */
  instructions?: EntryType;
  /** Descriptions of the available outcomes; at least one label is required. */
  criteria: T;
}

/** At least two descriptions indexed by score from zero; `null` leaves a score undescribed. */
export type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]];

/** A question that assigns a score using an ordered rubric. */
export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: "score";
  /** The question as text, a JSON object, or an array; optional or `null`. */
  instructions?: EntryType;
  /** Descriptions of the available outcomes. */
  criteria: T;
}

/** A question that locates what its instructions describe in the request's image. */
export interface BoxQuestion {
  type: "box";
  /** What to locate, as text, an asset, a JSON object, or an array; optional or `null`. */
  instructions?: EntryType;
}

/** A question identified by its `type` field. */
export type Question = NoulQuestion | ScoreQuestion | ChoiceQuestion | BoxQuestion;

/** Questions keyed by the names used to identify their answers. */
export interface Questions {
  [name: string]: Question;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** An asset sent with a request under a reference. */
export type Asset = Image;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** A yes/no answer. */
export interface NoulResponse {
  readonly type: "noul";
  /** Probability of a yes answer, from zero to one. */
  readonly noul: number;
}

/** A selected label and its probabilities. */
export interface ChoiceResponse<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  /** The selected label. */
  readonly choice: keyof T & string;
  /** Reported confidence in the selected label. */
  readonly confidence: number;
  /** Probabilities keyed by label. */
  readonly probabilities: {
    readonly [label in keyof T]: number;
  };
}

/** Score keys inferred from the rubric; a fixed-length tuple yields its indices, otherwise `number`. */
export type ScoreOf<T extends ScoreCriteria> = number extends T["length"]
  ? number
  : Extract<keyof T, `${number}`>;

/** Content as the API returns it, with assets and `withAssets` text written as strings. */
export type SentContent<T> = T extends Asset | TextWithAssets
  ? string
  : T extends object
    ? { readonly [key in keyof T]: SentContent<T[key]> }
    : T;

/** Rubric descriptions keyed by score. */
export type ScoreLegend<T extends ScoreCriteria> = {
  readonly [score in ScoreOf<T>]: SentContent<T[score]>;
};

/** An expected score with its rubric and probabilities. */
export interface ScoreResponse<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: "score";
  /** Expected score, which may fall between integer rubric levels. */
  readonly score: number;
  /** Reported confidence in the score. */
  readonly confidence: number;
  /** Rubric descriptions keyed by score. */
  readonly legend: ScoreLegend<T>;
  /** Probabilities keyed by score. */
  readonly probabilities: {
    readonly [score in ScoreOf<T>]: number;
  };
}

/** A box's edges as fractions of the image's height (`top`, `bottom`) and width (`left`, `right`). */
export interface BoxCoordinates {
  /** Top edge, as a fraction of image height from the top, from zero to one. */
  readonly top: number;
  /** Bottom edge, as a fraction of image height from the top, from zero to one. */
  readonly bottom: number;
  /** Left edge, as a fraction of image width from the left, from zero to one. */
  readonly left: number;
  /** Right edge, as a fraction of image width from the left, from zero to one. */
  readonly right: number;
}

/** The answer to a `box` question. */
export interface BoxResponse {
  readonly type: "box";
  /** Where the instructions' subject is in the image. */
  readonly box: BoxCoordinates;
  /** Confidence in the box, from zero to one, or `null` when the API didn't report it. */
  readonly confidence: number | null;
}

/** The answer type for a question, preserving its criteria keys. */
export type ResultFor<T extends Question> = T extends NoulQuestion
  ? NoulResponse
  : T extends ScoreQuestion<infer S>
    ? ScoreResponse<S>
    : T extends ChoiceQuestion<infer E>
      ? ChoiceResponse<E>
      : T extends BoxQuestion
        ? BoxResponse
        : never;

/** Token usage for a request. */
export interface Usage {
  /** Number of input tokens used, or `null` when the API did not report it. */
  readonly input_tokens: number | null;
  /** Number of output tokens used, or `null` when the API did not report it. */
  readonly output_tokens: number | null;
}

/** Answers keyed by question name, with model and usage metadata. */
export interface SystemOneResult<Q extends Questions> {
  /** The model used to answer the request. */
  readonly model: string;
  /** Answers with types inferred from the supplied questions. */
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  /** Token usage for the request. */
  readonly usage: Usage;
}

/** Metadata for an available model. */
export interface ModelCard {
  readonly name: string;
  readonly description: string;
  readonly release_date: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * State and named questions for `systemOne`.
 *
 * Additional properties on a request variable are forwarded, including `null` values.
 */
export interface SystemOneRequest<Q extends Questions = Questions> {
  /** Text, an asset, a JSON object, or an array to evaluate. */
  state: NonNullable<EntryType>;
  /** Nonempty questions keyed by the names used to identify their answers. */
  questions: Q;
  /** Model override; omitted values inherit `defaultModel`. */
  model?: string;
  /**
   * References mapped to assets, for referencing assets by name.
   *
   * References are matched literally in string values within `state`, question instructions,
   * or criteria. Use distinct delimiters (such as `<photo>`) to avoid matching ordinary text.
   * Assets placed directly in `state` or question content, or in `withAssets` text, are sent
   * without being listed here. Every name must appear in the request; otherwise the call
   * rejects before sending.
   */
  assets?: Record<string, Asset>;
}

/** Retry configuration. Partial overrides inherit unset fields from the client or SDK defaults. */
export interface RetryPolicy {
  /** Maximum retries after the initial attempt; `0` disables retries. Default: 2. */
  readonly maxRetries: number;
  /** First backoff delay in milliseconds, doubled up to `backoffMaxMs`. Default: 500. */
  readonly backoffInitialMs: number;
  /** Maximum backoff delay in milliseconds. Default: 5000. */
  readonly backoffMaxMs: number;
  /** Fraction of each backoff delay randomly subtracted, from 0 to 1. Default: 0.25. */
  readonly backoffJitter: number;
  /** HTTP status codes to retry. Default: 408, 429, and 500–599. */
  readonly httpStatuses: ReadonlySet<number>;
  /** Honor `Retry-After` and `retry-after-ms` up to `maxRetryAfterMs`. Default: true. */
  readonly respectRetryAfter: boolean;
  /** Maximum server retry delay in milliseconds; longer delays use backoff. Default: 60000. */
  readonly maxRetryAfterMs: number;
  /** Retry connection failures, including interrupted response bodies (`APIConnectionError`). Default: true. */
  readonly apiConnectionError: boolean;
  /** Whether to retry `APITimeoutError`. Default: true. */
  readonly apiTimeoutError: boolean;
}

/** Per-call options that override client settings. */
export interface RequestOptions {
  /** Cancellation signal for the request and pending retries. */
  signal?: AbortSignal;
  /** Timeout per attempt in milliseconds; there is no total retry budget. */
  timeout?: number;
  /** Retry overrides for this call; omitted fields inherit client settings. */
  retry?: Partial<RetryPolicy>;
  /** Additional headers, merged over `defaultHeaders`. */
  headers?: Record<string, string>;
}

/** HTTP fetch implementation compatible with the global `fetch`. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Request body compression: `"zstd"`, or `false` to send bodies uncompressed. */
export type Compression = "zstd" | false;

/** Log verbosity; `off` disables logging. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

/** Log methods accepting a message and structured values; compatible with `console`. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Client options. Explicit values take precedence over environment variables, then SDK defaults. */
export interface DecisionClientConfig {
  /** Required API key; falls back to `TSOLVE_DECISION_API_KEY`. */
  apiKey?: string;
  /** API root; falls back to `TSOLVE_DECISION_BASE_URL`, then `http://127.0.0.1:8787`. */
  baseURL?: string;
  /** Default model; falls back to `TSOLVE_DECISION_DEFAULT_MODEL`, then `tsolve-decision`. */
  defaultModel?: string;
  /**
   * Log level; falls back to `TSOLVE_DECISION_LOG_LEVEL`, then `warn`.
   * `info` logs request summaries; `debug` adds headers and bodies.
   * Known credential headers are redacted; bodies are not.
   */
  logLevel?: LogLevel;
  /** Logger filtered to `logLevel` and above. Default: prefixed `console`. */
  logger?: Logger;
  /** Retry overrides; omitted fields use the defaults in `RetryPolicy`. */
  retry?: Partial<RetryPolicy>;
  /** Timeout per attempt in milliseconds, without a total retry budget. Default: 10000. */
  timeout?: number;
  /** Additional request headers; per-call headers take precedence. */
  defaultHeaders?: Record<string, string>;
  /**
   * Request body compression, sent as `Content-Encoding`. Default: `"zstd"` on runtimes that
   * have it (Node.js 22.15 or newer), otherwise `false`. Bodies under 1 KiB are always sent
   * uncompressed. Pass `false` to send all bodies uncompressed, for example to an API that
   * doesn't accept compressed requests.
   */
  compression?: Compression;
  /** Allow browser use, exposing the API key to page users. Default: false. */
  dangerouslyAllowBrowser?: boolean;
  /** Custom HTTP fetch implementation for transport configuration or tests. Default: global `fetch`. */
  fetch?: Fetch;
}
