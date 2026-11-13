import { DASHBOARD_URL, InvalidApiKeyError, type KeySource, MissingApiKeyError } from "./auth/api-key.js";
import { V3ApiError, V3InterruptedError, V3NetworkError, V3TimeoutError } from "./client.js";

const DAY_SECONDS = 86_400;
const SUPPORT_EMAIL = "support@enrichlayer.com";

export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  key: 3,
  notFound: 4,
  notNow: 5,
  noAnswer: 6,
  stopped: 130,
} as const;

const MAY_BE_CHARGED = "The call may still be charged.";
const SAVED_COPY_ADVICE =
  "To get the copy that was saved in the meantime, run the same command without --max-age-seconds; do not repeat a live lookup right away.";

export function cutOffAdvice(hasMaxAgeSeconds: boolean): string {
  return hasMaxAgeSeconds ? `${MAY_BE_CHARGED} ${SAVED_COPY_ADVICE}` : MAY_BE_CHARGED;
}

export interface FailureContext {
  keySource: KeySource;
  hasMaxAgeSeconds: boolean;
}

export interface Failure {
  message: string;
  exitCode: number;
}

function details(error: V3ApiError | V3InterruptedError): string {
  const parts = [`credits charged: ${error.creditCost ?? "unknown"}`];
  if (error.requestId) parts.push(`request id: ${error.requestId}`);
  return ` (${parts.join(", ")})`;
}

function apiFailure(error: V3ApiError, keySource: KeySource): Failure {
  const reason = (error.body.description ?? error.body.name ?? `HTTP ${error.status}`).replace(/[.\s]+$/, "");
  const age = error.body.cachedProfileAgeSeconds;

  if (error.status === 400)
    return { message: `The request was rejected as invalid: ${reason}. Fix the flags and run again.`, exitCode: EXIT_CODES.usage };
  if (error.status === 401)
    return {
      message: `The API key from ${keySource} was rejected: ${reason}. Use a valid key from ${DASHBOARD_URL}.`,
      exitCode: EXIT_CODES.key,
    };
  if (error.status === 403) {
    if (/insufficient credits|top.?up/i.test(reason))
      return {
        message: `Not enough credits: ${reason}. Top up the account at ${DASHBOARD_URL}, then run again.`,
        exitCode: EXIT_CODES.key,
      };
    return {
      message: `Access denied for ${error.path}: ${reason}. This key or its account cannot use this endpoint; use a key that can, or contact ${SUPPORT_EMAIL}.`,
      exitCode: EXIT_CODES.key,
    };
  }
  if (error.status === 404)
    return {
      message: `Not found: ${reason}. Check the identifier (URL, username, email or domain), or look it up by another identifier.`,
      exitCode: EXIT_CODES.notFound,
    };
  if (error.status === 409) {
    const cached =
      typeof age === "number"
        ? ` The newest cached copy is ${Math.floor(age / DAY_SECONDS)} days old (${age} s). Run again later, or pass --max-age-seconds ${age} or more to accept it.`
        : " Run again later, or raise --max-age-seconds to accept an older cached copy.";
    return { message: `No copy is fresh enough and a live lookup did not succeed: ${reason}.${cached}`, exitCode: EXIT_CODES.notNow };
  }
  if (error.status === 429)
    return {
      message: `Rate limit reached for this account: ${reason}. The limit is counted per account, and new accounts have a very small limit until their first payment; wait a minute and run again.`,
      exitCode: EXIT_CODES.notNow,
    };
  if (error.status >= 500)
    return {
      message: `Enrich Layer is unavailable right now (${error.status}): ${reason}. Try again in a few minutes.`,
      exitCode: EXIT_CODES.notNow,
    };
  return {
    message: `Enrich Layer API error ${error.status}: ${reason}. Try again later; if it keeps failing, contact ${SUPPORT_EMAIL} with the request id.`,
    exitCode: EXIT_CODES.unexpected,
  };
}

export function describeFailure(error: unknown, { keySource, hasMaxAgeSeconds }: FailureContext): Failure {
  if (error instanceof V3ApiError) {
    const failure = apiFailure(error, keySource);
    return { ...failure, message: failure.message + details(error) };
  }
  if (error instanceof V3InterruptedError)
    return { message: `${error.message}. ${cutOffAdvice(hasMaxAgeSeconds)}${details(error)}`, exitCode: EXIT_CODES.noAnswer };
  if (error instanceof V3TimeoutError)
    return { message: `${error.message}. ${cutOffAdvice(hasMaxAgeSeconds)}`, exitCode: EXIT_CODES.noAnswer };
  if (error instanceof V3NetworkError)
    return {
      message: `${error.message}. Check the network connection and ENRICHLAYER_API_BASE_URL, then run again.`,
      exitCode: EXIT_CODES.notNow,
    };
  if (error instanceof MissingApiKeyError || error instanceof InvalidApiKeyError)
    return { message: error.message, exitCode: EXIT_CODES.key };
  return { message: error instanceof Error ? error.message : String(error), exitCode: EXIT_CODES.unexpected };
}
