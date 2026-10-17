import type { APIPromise } from "../api-promise.ts";
import type { Transport } from "../client.ts";
import { DecisionError } from "../errors.ts";
import type { ModelCard, RequestOptions } from "../types.ts";

/** Access to the Models API resource. */
export class Models {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** List the models available to the account. */
  list(options: RequestOptions = {}): APIPromise<ModelCard[]> {
    return this.#transport.request<ModelsWire>("GET", "/v1/models", options).map(unwrapModels);
  }
}

/** Model list response from `GET /v1/models`. */
type ModelsWire = { models: ModelCard[] };

const unwrapModels = (wire: ModelsWire): ModelCard[] => {
  if (Array.isArray(wire?.models)) return wire.models;
  throw new DecisionError(
    "Unexpected response shape from GET /v1/models; expected { models: [...] }.",
  );
};
