import { headers, startApi, testClient } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyCredentials } from "../build/auth/api-key.js";
import { V3TimeoutError } from "../build/client.js";
import { describeFailure } from "../build/errors.js";

const FROM_ENV = { keySource: "ENRICHLAYER_API_KEY", hasMaxAgeSeconds: true };
const SAVED_COPY =
  "The call may still be charged. To get the copy that was saved in the meantime, run the same command without --max-age-seconds; do not repeat a live lookup right away.";

async function failureFor(reply, { context = FROM_ENV, baseUrl, credentials } = {}) {
  const api = await startApi(() => reply);
  try {
    const callV3 = testClient(baseUrl ?? api.url, credentials ? { credentials } : {});
    await callV3({ path: "/v3/person", params: { profile: "jane" } });
  } catch (error) {
    return describeFailure(error, context);
  } finally {
    await api.close();
  }
  assert.fail("the call did not fail");
}

test("400 asks to fix the flags", async () => {
  const failure = await failureFor({
    status: 400,
    body: { code: 400, name: "Bad Request", description: "Invalid LinkedIn URL." },
    headers: headers(0, "req-400"),
  });

  assert.deepEqual(failure, {
    message: "The request was rejected as invalid: Invalid LinkedIn URL. Fix the flags and run again. (credits charged: 0, request id: req-400)",
    exitCode: 2,
  });
});

test("401 names where the rejected key came from", async () => {
  const failure = await failureFor(
    { status: 401, body: { code: 401, name: "Unauthorized", description: "Invalid API key" }, headers: headers(0, "req-401") },
    { context: { keySource: "--api-key", hasMaxAgeSeconds: true } },
  );

  assert.deepEqual(failure, {
    message:
      "The API key from --api-key was rejected: Invalid API key. Use a valid key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-401)",
    exitCode: 3,
  });
});

test("403 without credits asks to top up", async () => {
  const failure = await failureFor({
    status: 403,
    body: { code: 403, name: "Forbidden", description: "Insufficient credits" },
    headers: headers(0, "req-403"),
  });

  assert.deepEqual(failure, {
    message:
      "Not enough credits: Insufficient credits. Top up the account at https://enrichlayer.com/dashboard, then run again. (credits charged: 0, request id: req-403)",
    exitCode: 3,
  });
});

test("other 403 is access denied for the path", async () => {
  const failure = await failureFor({
    status: 403,
    body: { code: 403, name: "Forbidden", description: "Forbidden" },
    headers: headers(0, "req-403b"),
  });

  assert.deepEqual(failure, {
    message:
      "Access denied for /v3/person: Forbidden. This key or its account cannot use this endpoint; use a key that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-403b)",
    exitCode: 3,
  });
});

test("404 is not found", async () => {
  const failure = await failureFor({
    status: 404,
    body: { code: 404, name: "Not Found", description: "Person not found" },
    headers: headers(0, "req-404"),
  });

  assert.deepEqual(failure, {
    message:
      "Not found: Person not found. Check the identifier (URL, username, email or domain), or look it up by another identifier. (credits charged: 0, request id: req-404)",
    exitCode: 4,
  });
});

test("409 with the age of the cached copy tells which --max-age-seconds accepts it", async () => {
  const failure = await failureFor({
    status: 409,
    body: { code: 409, name: "FreshnessConflictError", description: "Freshness conflict", cachedProfileAgeSeconds: 864000 },
    headers: headers(0, "req-409"),
  });

  assert.deepEqual(failure, {
    message:
      "No copy is fresh enough and a live lookup did not succeed: Freshness conflict. The newest cached copy is 10 days old (864000 s). Run again later, or pass --max-age-seconds 864000 or more to accept it. (credits charged: 0, request id: req-409)",
    exitCode: 5,
  });
});

test("409 without the age asks to raise --max-age-seconds", async () => {
  const failure = await failureFor({
    status: 409,
    body: { code: 409, name: "FreshnessConflictError", description: "Freshness conflict" },
    headers: headers(0, "req-409b"),
  });

  assert.deepEqual(failure, {
    message:
      "No copy is fresh enough and a live lookup did not succeed: Freshness conflict. Run again later, or raise --max-age-seconds to accept an older cached copy. (credits charged: 0, request id: req-409b)",
    exitCode: 5,
  });
});

test("429 after the retries asks to wait", async () => {
  const failure = await failureFor({
    status: 429,
    body: { code: 429, name: "Too Many Requests", description: "Rate limit exceeded" },
    headers: { ...headers(0, "req-429"), "Retry-After": "0" },
  });

  assert.deepEqual(failure, {
    message:
      "Rate limit reached for this account: Rate limit exceeded. The limit is counted per account, and new accounts have a very small limit until their first payment; wait a minute and run again. (credits charged: 0, request id: req-429)",
    exitCode: 5,
  });
});

test("5xx after the retries asks to try again later", async () => {
  const failure = await failureFor({
    status: 503,
    body: { code: 503, name: "Service Unavailable", description: "Billing service unavailable" },
    headers: headers(0, "req-503"),
  });

  assert.deepEqual(failure, {
    message: "Enrich Layer is unavailable right now (503): Billing service unavailable. Try again in a few minutes. (credits charged: 0, request id: req-503)",
    exitCode: 5,
  });
});

test("another status is an unexpected error with the request id", async () => {
  const failure = await failureFor({ status: 418, body: { description: "I'm a teapot" }, headers: headers(0, "req-418") });

  assert.deepEqual(failure, {
    message:
      "Enrich Layer API error 418: I'm a teapot. Try again later; if it keeps failing, contact support@enrichlayer.com with the request id. (credits charged: 0, request id: req-418)",
    exitCode: 1,
  });
});

test("an answer that is not JSON is an unexpected error", async () => {
  const failure = await failureFor({ body: "<html>gateway</html>" });

  assert.deepEqual(failure, {
    message:
      "Enrich Layer API error 200: The answer is not valid JSON. Try again later; if it keeps failing, contact support@enrichlayer.com with the request id. (credits charged: unknown)",
    exitCode: 1,
  });
});

test("an answer cut off on the way may be charged", async () => {
  const failure = await failureFor({ body: '{"fullName":"Ja', dropAfterBody: true, headers: headers(10, "req-cut") });

  assert.deepEqual(failure, {
    message: `The connection broke while the answer was arriving (HTTP 200). ${SAVED_COPY} (credits charged: 10, request id: req-cut)`,
    exitCode: 6,
  });
});

test("a timeout may be charged; without --max-age-seconds the advice is short", () => {
  assert.deepEqual(describeFailure(new V3TimeoutError(301_400), FROM_ENV), {
    message: `Enrich Layer did not answer within 301 s. ${SAVED_COPY}`,
    exitCode: 6,
  });
  assert.deepEqual(describeFailure(new V3TimeoutError(301_400), { ...FROM_ENV, hasMaxAgeSeconds: false }), {
    message: "Enrich Layer did not answer within 301 s. The call may still be charged.",
    exitCode: 6,
  });
});

test("an unreachable host asks to check the network and ENRICHLAYER_API_BASE_URL", async () => {
  const closed = await startApi(() => ({ body: {} }));
  await closed.close();
  const host = new URL(closed.url).host;

  const failure = await failureFor({ body: {} }, { baseUrl: closed.url });

  assert.deepEqual(failure, {
    message: `Could not reach Enrich Layer at ${closed.url}: connect ECONNREFUSED ${host}. Check the network connection and ENRICHLAYER_API_BASE_URL, then run again.`,
    exitCode: 5,
  });
});

test("no key and a key with bad characters exit with the key code", async () => {
  assert.deepEqual(await failureFor({ body: {} }, { credentials: apiKeyCredentials({ env: {} }) }), {
    message: "No API key. Set ENRICHLAYER_API_KEY or pass --api-key; create a key at https://enrichlayer.com/dashboard.",
    exitCode: 3,
  });
  assert.deepEqual(await failureFor({ body: {} }, { credentials: apiKeyCredentials({ flag: "bad key" }) }), {
    message:
      "The API key from --api-key contains a space, a line break or another character an API key cannot have. Copy the key again from https://enrichlayer.com/dashboard.",
    exitCode: 3,
  });
});
