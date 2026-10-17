import { DecisionError } from "./errors.ts";
import type { Compression } from "./types.ts";

/** Bodies below this many bytes fit in a single TCP segment, so they are sent uncompressed. */
export const MIN_COMPRESSED_BODY_BYTES = 1024;

interface Zlib {
  zstdCompress?: (
    data: Uint8Array,
    callback: (err: Error | null, result: Uint8Array) => void,
  ) => void;
}

interface CompressionGlobals {
  process?: { getBuiltinModule?: (id: string) => unknown };
}

const g = globalThis as CompressionGlobals;

/** `node:zlib`, read without an import so the SDK still loads where Node modules don't exist. */
const zlib = (): Zlib | undefined => {
  try {
    return g.process?.getBuiltinModule?.("node:zlib") as Zlib | undefined;
  } catch {
    return undefined;
  }
};

const hasZstd = (): boolean => typeof zlib()?.zstdCompress === "function";

/**
 * Resolve the `compression` option to the `Content-Encoding` request bodies are sent with:
 * zstd when the runtime has it, otherwise `false`.
 *
 * @throws {DecisionError} The value isn't a supported option, or the runtime lacks it.
 */
export const resolveCompression = (compression: Compression | undefined): Compression => {
  if (compression === undefined) return hasZstd() ? "zstd" : false;
  if (compression === false) return false;
  if (compression === "zstd") {
    if (!hasZstd()) {
      throw new DecisionError(
        "zstd compression requires Node.js 22.15 or newer. Pass `compression: false` instead.",
      );
    }
    return compression;
  }
  throw new DecisionError(
    `\`compression\` must be "zstd" or false, got ${JSON.stringify(compression)}.`,
  );
};

const zstd = async (body: Blob): Promise<Uint8Array<ArrayBuffer>> => {
  const data = new Uint8Array(await body.arrayBuffer());
  const compressed = await new Promise<Uint8Array>((resolve, reject) => {
    zlib()?.zstdCompress?.(data, (err, result) => (err ? reject(err) : resolve(result)));
  });
  return new Uint8Array(compressed);
};

/** The size of a request body in bytes, with text measured as UTF-8. */
export const byteLength = (body: string | Blob): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.size;

/** Compress a request body with zstd. */
export const compressBody = (body: string | Blob): Promise<Uint8Array<ArrayBuffer>> =>
  zstd(typeof body === "string" ? new Blob([body]) : body);
