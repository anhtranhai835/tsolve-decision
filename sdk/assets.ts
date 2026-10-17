import { DecisionError } from "./errors.ts";
import type { Asset } from "./types.ts";

/**
 * The file signatures that PNG (PNG spec §5.2) and JPEG (ITU T.81 SOI marker) files start
 * with, and the content type each identifies.
 */
const CONTENT_TYPES = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
] as const;

/** Matches `String(image)`: the reference an image is sent under. */
const REFERENCE = /<image:[0-9a-f]{32}>/g;

/** Marks `Image` objects, including those created by another copy of the SDK. */
const IMAGE = Symbol.for("@tsolve/decision-sdk/image");

/** Marks `TextWithAssets` objects, including those created by another copy of the SDK. */
const TEXT_WITH_ASSETS = Symbol.for("@tsolve/decision-sdk/text-with-assets");

/** 32 random lowercase hex digits. */
const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const isImage = (value: object): value is Image => IMAGE in value;

const isTextWithAssets = (value: object): value is TextWithAssets => TEXT_WITH_ASSETS in value;

/** `value`'s `Symbol.toStringTag`, such as `Promise`, or its `typeof` when it isn't an object. */
const typeName = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return Object.prototype.toString.call(value).slice(8, -1);
};

/** A `Uint8Array` over the bytes `data` holds or views, without copying them. */
const toBytes = (data: ArrayBuffer | ArrayBufferView): Uint8Array => {
  // The tag check also matches an ArrayBuffer from another realm, such as an iframe.
  if (
    !ArrayBuffer.isView(data) &&
    Object.prototype.toString.call(data) !== "[object ArrayBuffer]"
  ) {
    throw new DecisionError(`Image data must be file bytes or a Blob; got ${typeName(data)}.`);
  }
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
};

/** The content type whose signature `bytes` start with, or `application/octet-stream`. */
const contentTypeOf = (bytes: Uint8Array): string => {
  for (const [contentType, signature] of CONTENT_TYPES) {
    if (signature.every((byte, i) => bytes[i] === byte)) return contentType;
  }
  return "application/octet-stream";
};

/** A PNG or JPEG image asset, created by `image` or `Image.fromBase64`. */
export class Image {
  readonly type = "image";
  /** The image file bytes, or a `Blob` read when the request is sent. */
  readonly data: Uint8Array | Blob;
  readonly #reference = `<image:${randomHex()}>`;

  /** @throws {DecisionError} `data` is empty or isn't file bytes or a `Blob`. */
  constructor(data: Blob | ArrayBuffer | ArrayBufferView) {
    this.data = data instanceof Blob ? data : toBytes(data);
    const size = this.data instanceof Blob ? this.data.size : this.data.byteLength;
    if (size === 0) throw new DecisionError("Image data is empty.");
  }

  /**
   * Create an image from base64-encoded file bytes, decoding them now.
   *
   * @param text - The image file bytes, base64-encoded, without a `data:` URL prefix.
   * @throws {DecisionError} `text` isn't valid base64 or decodes to no bytes.
   *
   * @example
   * ```ts
   * const photo = Image.fromBase64(upload.photoBase64);
   * ```
   */
  static fromBase64(text: string): Image {
    let binary: string;
    try {
      binary = atob(text);
    } catch (err) {
      throw new DecisionError("Image data must contain valid base64 text.", { cause: err });
    }
    return new Image(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  }

  /** The unique reference this image is sent under, for referencing it inside text. */
  toString(): string {
    return this.#reference;
  }

  /** The reference, written by `JSON.stringify` wherever the image appears in a request. */
  toJSON(): string {
    return this.#reference;
  }
}
Object.defineProperty(Image.prototype, IMAGE, { value: true });

/** Text from a `withAssets` tagged template, with the assets interpolated into it. */
export class TextWithAssets {
  /** The text, with each asset replaced by its reference. */
  readonly text: string;
  /** The assets interpolated into the text, including those in nested `withAssets` text. */
  readonly assets: readonly Asset[];

  constructor(text: string, assets: readonly Asset[]) {
    this.text = text;
    this.assets = assets;
  }

  toString(): string {
    return this.text;
  }

  /** The text, written by `JSON.stringify` wherever this value appears in a request. */
  toJSON(): string {
    return this.text;
  }
}
Object.defineProperty(TextWithAssets.prototype, TEXT_WITH_ASSETS, { value: true });

/**
 * Create an image asset for `systemOne`.
 *
 * Place the image in `state` or question content, or interpolate it into a `withAssets`
 * tagged template; either way it is sent under its own reference, `String(image)`. To
 * reference it by a name of your choice, pass it in `assets` instead.
 *
 * The image must be PNG or JPEG. The API detects the format from the file bytes and rejects
 * other formats with a `BadRequestError`. `Blob` data is read when the request is sent, and its
 * `type` is ignored. For base64 text, use `Image.fromBase64`.
 *
 * @param data - Image file bytes, or a `Blob` such as a `File`.
 * @throws {DecisionError} `data` is empty or isn't file bytes or a `Blob`.
 *
 * @example
 * ```ts
 * // Node: `openAsBlob` reads a file as a Blob and is exported by "node:fs".
 * const { answers } = await client.systemOne({
 *   state: image(await openAsBlob("product.png")),
 *   questions: { damaged: noul("Is the product damaged?") },
 * });
 * ```
 */
export const image = (data: Blob | ArrayBuffer | ArrayBufferView): Image => new Image(data);

/** `text` with the assets in `values` whose references it contains, in order of appearance. */
const textWithAssets = (text: string, values: readonly unknown[]): TextWithAssets => {
  const interpolated = new Map<string, Asset>();
  collectAssets(values, interpolated, new Set());
  const assets = new Map<string, Asset>();
  for (const [reference] of text.matchAll(REFERENCE)) {
    const asset = interpolated.get(reference);
    if (asset !== undefined) assets.set(reference, asset);
  }
  return new TextWithAssets(text, [...assets.values()]);
};

/**
 * Tag a template literal so the assets interpolated into it are sent with the text.
 *
 * Each asset is replaced by its reference; other values are converted to strings, as in an
 * untagged template literal. To write a list of assets with a separator, use
 * `withAssets.join`.
 *
 * @example
 * ```ts
 * const { answers } = await client.systemOne({
 *   state: withAssets`Compare ${photo} with the listing.`,
 *   questions: { same: noul(withAssets`Is ${photo} the product in ${listing}?`) },
 * });
 * ```
 */
export const withAssets: {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): TextWithAssets;
  /**
   * Join `values` with `separator`, as `Array.prototype.join` does, and send the assets among
   * them with the text. The result can be passed as content or interpolated into `withAssets`.
   *
   * @param separator - Written between values. Default: `","`.
   *
   * @example
   * ```ts
   * const { answers } = await client.systemOne({
   *   state: withAssets`The seller uploaded ${withAssets.join(uploads, ", ")}.`,
   *   questions: { same: noul("Do the uploads show the same product?") },
   * });
   * ```
   */
  join(values: readonly unknown[], separator?: string): TextWithAssets;
} = Object.assign(
  (strings: TemplateStringsArray, ...values: readonly unknown[]): TextWithAssets =>
    textWithAssets(
      strings.reduce((joined, piece, i) => joined + String(values[i - 1]) + piece),
      values,
    ),
  {
    join: (values: readonly unknown[], separator?: string): TextWithAssets =>
      textWithAssets(values.join(separator), values),
  },
);

/** Add the assets in `value`, including those in `withAssets` text, to `found` by reference. */
const collectAssets = (value: unknown, found: Map<string, Asset>, visited: Set<object>): void => {
  if (typeof value !== "object" || value === null || visited.has(value)) return;
  visited.add(value);
  if (isImage(value)) found.set(String(value), value);
  else if (isTextWithAssets(value))
    for (const asset of value.assets) found.set(String(asset), asset);
  else for (const item of Object.values(value)) collectAssets(item, found, visited);
};

/**
 * Serialize `payload` to JSON, writing each asset as its name in `assets`, or else as its
 * reference, and collect the assets the request sends.
 *
 * The assets are those in `assets`, then each asset whose reference appears in the JSON, in
 * order of appearance: assets placed in content, in `withAssets` text, or in `assets`.
 *
 * @throws {DecisionError} The JSON holds the reference of an asset not attached to the request,
 *   or doesn't contain the name of an asset in `assets`.
 */
export const serializeRequest = (
  payload: object,
  assets: Record<string, Asset> = {},
): { json: string; assets: Record<string, Asset> | undefined } => {
  // An asset under several names is written as the last one.
  const names = new Map<object, string>(
    Object.entries(assets).map(([name, asset]) => [asset, name]),
  );
  const known = new Map(Object.values(assets).map((asset) => [String(asset), asset]));
  const json = JSON.stringify(
    payload,
    function (this: Record<string, unknown>, key: string, value: unknown): unknown {
      // `JSON.stringify` writes NaN and infinities as `null`; send them as strings instead.
      if (typeof value === "number" && !Number.isFinite(value)) return String(value);
      // `value` is the result of `toJSON`, so the original is read from the holder.
      const original = this[key];
      if (typeof original !== "object" || original === null) return value;
      if (isImage(original)) {
        const name = names.get(original);
        if (name !== undefined) return name;
        known.set(String(original), original);
      } else if (isTextWithAssets(original)) {
        let text = original.text;
        for (const asset of original.assets) {
          const name = names.get(asset);
          if (name === undefined) known.set(String(asset), asset);
          else text = text.replaceAll(String(asset), name);
        }
        return text;
      }
      return value;
    },
  );
  // Names are matched as they appear in the JSON, with quotes and backslashes escaped.
  const unreferenced = Object.keys(assets).filter(
    (name) => !json.includes(JSON.stringify(name).slice(1, -1)),
  );
  if (unreferenced.length > 0) {
    throw new DecisionError(
      `Assets not referenced in the request: ${unreferenced.join(", ")}. ` +
        "Write each name in `assets` into `state`, question instructions, or criteria.",
    );
  }
  const sent = new Map(Object.entries(assets));
  const missing = new Set<string>();
  for (const [reference] of json.matchAll(REFERENCE)) {
    if (sent.has(reference)) continue;
    const asset = known.get(reference);
    if (asset === undefined) missing.add(reference);
    else sent.set(reference, asset);
  }
  if (missing.size > 0) {
    throw new DecisionError(
      `Image references without an attached image: ${[...missing].join(", ")}. ` +
        "Tag template literals that interpolate images with `withAssets`.",
    );
  }
  return { json, assets: sent.size === 0 ? undefined : Object.fromEntries(sent) };
};

/** An image asset as sent in a `multipart/form-data` body, naming the part with its file bytes. */
export interface ImagePartAsset {
  type: "image";
  /** The name of the body part that holds the image file bytes. */
  part: string;
}

/** A part of a `multipart/form-data` body. */
interface Part {
  /** Written unescaped, so it must be ASCII without quotes. */
  name: string;
  contentType: string;
  content: string | Uint8Array<ArrayBuffer>;
  /** Written unescaped, so it must be ASCII without quotes. */
  filename?: string;
}

/** A `multipart/form-data` request body (RFC 7578) whose first part is a JSON payload. */
export class MultipartBody {
  /** The JSON payload, sent as the `request` part. */
  readonly payload: unknown;
  /** The `Content-Type` header value, including the boundary. */
  readonly contentType: string;
  /** The encoded body. */
  readonly content: Blob;

  constructor(payload: unknown, parts: readonly Part[]) {
    // A random boundary, as browsers use, is practically certain not to occur in the content.
    const boundary = randomHex();
    const chunks: (string | Uint8Array<ArrayBuffer>)[] = [];
    for (const { name, contentType, content, filename } of [
      { name: "request", contentType: "application/json", content: JSON.stringify(payload) },
      ...parts,
    ]) {
      const disposition =
        filename === undefined ? `name="${name}"` : `name="${name}"; filename="${filename}"`;
      chunks.push(
        `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\n`,
        `Content-Type: ${contentType}\r\n\r\n`,
        content,
        "\r\n",
      );
    }
    chunks.push(`--${boundary}--\r\n`);
    this.payload = payload;
    this.contentType = `multipart/form-data; boundary=${boundary}`;
    this.content = new Blob(chunks);
  }
}

/** The image's file bytes, reading `Blob` data. */
const readImage = async (alias: string, { data }: Image): Promise<Uint8Array> => {
  if (!(data instanceof Blob)) return data;
  try {
    return new Uint8Array(await data.arrayBuffer());
  } catch (err) {
    throw new DecisionError(`Asset "${alias}" could not be read: ${(err as Error).message}`, {
      cause: err,
    });
  }
};

/** `bytes`, copied when backed by a `SharedArrayBuffer`, which `Blob` doesn't accept. */
const unshared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();

/**
 * `assets`, with each asset's file bytes copied, so writes to the caller's buffers after this
 * call don't change what is sent. `Blob` data can't change, and isn't copied.
 */
export const copyAssetBytes = (assets: Record<string, Asset>): Record<string, Asset> =>
  Object.fromEntries(
    Object.entries(assets).map(([alias, asset]) => [
      alias,
      asset.data instanceof Uint8Array ? new Image(asset.data.slice()) : asset,
    ]),
  );

/**
 * A `multipart/form-data` body whose first part, `request`, is `payload` with `assets` added,
 * followed by each asset's file bytes in a part its entry names. `Blob` data is read
 * concurrently.
 *
 * @throws {DecisionError} A `Blob` can't be read.
 */
export const encodeAssets = async (
  payload: object,
  assets: Record<string, Asset>,
): Promise<MultipartBody> => {
  const read = await Promise.all(
    Object.entries(assets).map(
      async ([alias, asset]) => [alias, asset, await readImage(alias, asset)] as const,
    ),
  );
  // The API accepts each part for only one asset, so an asset under several references is
  // sent once per reference.
  const parts: Part[] = [];
  const entries: [string, ImagePartAsset][] = [];
  for (const [alias, { type }, data] of read) {
    const name = `asset-${parts.length}`;
    parts.push({ name, contentType: contentTypeOf(data), content: unshared(data), filename: name });
    entries.push([alias, { type, part: name }]);
  }
  return new MultipartBody({ ...payload, assets: Object.fromEntries(entries) }, parts);
};
