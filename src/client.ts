import { setTimeout as sleep } from "node:timers/promises";
import type { Credentials } from "./auth/api-key.js";

export interface V3Result {
  data: unknown;
  creditCost: number | null;
  requestId: string | null;
}

export interface V3ErrorBody {
  code?: number;
  name?: string;
  description?: string;
  cachedProfileAgeSeconds?: number;
}

export type V3Params = Record<string, string | number | boolean | undefined>;

export interface V3Request {
  path: string;
  params: V3Params;
  signal?: AbortSignal;
  clientName?: string;
}

export type CallV3 = (request: V3Request) => Promise<V3Result>;

export interface ClientOptions {
  baseUrl: string;
  userAgent: string;
  credentials: Credentials;
  timeoutMs: number;
  retryDelaysMs: number[];
}

export class V3ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: V3ErrorBody,
    readonly creditCost: number | null,
    readonly requestId: string | null,
  ) {
    super(`Enrich Layer API error ${status}: ${body.description ?? body.name ?? "no details"}`);
    this.name = "V3ApiError";
  }
}

export class V3TimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`Enrich Layer did not answer within ${Math.round(elapsedMs / 1000)} s`);
    this.name = "V3TimeoutError";
  }
}

function networkReason(cause: unknown): string {
  if (cause instanceof TypeError) return "the request could not be built";
  return cause instanceof Error ? cause.message : String(cause);
}

export class V3NetworkError extends Error {
  constructor(readonly baseUrl: string, cause: unknown) {
    super(`Could not reach Enrich Layer at ${baseUrl}: ${networkReason(cause)}`);
    this.name = "V3NetworkError";
  }
}

export class V3InterruptedError extends Error {
  constructor(
    readonly status: number,
    readonly creditCost: number | null,
    readonly requestId: string | null,
  ) {
    super(`The connection broke while the answer was arriving (HTTP ${status})`);
    this.name = "V3InterruptedError";
  }
}

const MAX_RETRY_AFTER_MS = 30_000;
const FETCH_HEADERS_TIMEOUT = "UND_ERR_HEADERS_TIMEOUT";

function headerNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function retryAfterMs(response: Response): number | null {
  const seconds = headerNumber(response.headers.get("retry-after"));
  return seconds === null || seconds < 0 ? null : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function errorBody(text: string): V3ErrorBody {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as V3ErrorBody;
  } catch {
    // not JSON — keep the raw text below
  }
  return { description: text.slice(0, 300) || undefined };
}

export function userAgentFor(userAgent: string, clientName: string | undefined): string {
  const name = clientName?.replace(/[^\x20-\x7e]|[()]/g, "").trim().slice(0, 64);
  return name ? `${userAgent} (${name})` : userAgent;
}

export function requestUrl(baseUrl: string, path: string, params: V3Params): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return `${baseUrl}${path}${query.size > 0 ? `?${query}` : ""}`;
}

export function createV3Client(options: ClientOptions): CallV3 {
  return async ({ path, params, signal, clientName }) => {
    const authorization = options.credentials.authorization();
    const userAgent = userAgentFor(options.userAgent, clientName);
    const url = requestUrl(options.baseUrl, path, params);
    const started = performance.now();
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

    try {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await fetch(url, {
            method: "GET",
            headers: { Authorization: authorization, Accept: "application/json", "User-Agent": userAgent },
            signal: abort,
          });
        } catch (error) {
          if (abort.aborted) throw error;
          const cause = (error as Error).cause ?? error;
          if ((cause as { code?: unknown }).code === FETCH_HEADERS_TIMEOUT) throw new V3TimeoutError(performance.now() - started);
          throw new V3NetworkError(options.baseUrl, cause);
        }

        const creditCost = headerNumber(response.headers.get("x-enrichlayer-credit-cost"));
        const requestId = response.headers.get("x-request-id");
        const retryable = response.status === 429 || response.status >= 500;

        if (retryable && attempt < options.retryDelaysMs.length) {
          await response.body?.cancel();
          await sleep(retryAfterMs(response) ?? options.retryDelaysMs[attempt], undefined, { signal: abort });
          continue;
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          if (abort.aborted) throw error;
          throw new V3InterruptedError(response.status, creditCost, requestId);
        }
        if (!response.ok) throw new V3ApiError(path, response.status, errorBody(text), creditCost, requestId);
        try {
          return { data: JSON.parse(text), creditCost, requestId };
        } catch {
          throw new V3ApiError(path, response.status, { description: "The answer is not valid JSON" }, creditCost, requestId);
        }
      }
    } catch (error) {
      if (deadline.aborted && !signal?.aborted) throw new V3TimeoutError(performance.now() - started);
      throw error;
    }
  };
}
