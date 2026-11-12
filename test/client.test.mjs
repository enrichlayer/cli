import { headers, startApi, testClient } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyCredentials, MissingApiKeyError } from "../build/auth/api-key.js";
import { userAgentFor, V3ApiError, V3NetworkError, V3TimeoutError } from "../build/client.js";
import { USER_AGENT } from "../build/config.js";

const PERSON = { fullName: "Jane Example", experience: { work: [] } };

test("sends a GET with the key, the user agent and only the given params", async (t) => {
  const api = await startApi(() => ({ body: PERSON, headers: headers(1, "req-1") }));
  t.after(api.close);

  await testClient(api.url)({ path: "/v3/person", params: { profile: "https://linkedin.com/in/jane/", workEmail: "include", email: undefined, github: "" } });

  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/v3/person");
  assert.deepEqual(request.query, { profile: "https://linkedin.com/in/jane/", workEmail: "include" });
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.equal(request.headers["user-agent"], USER_AGENT);
  assert.equal(request.headers.accept, "application/json");
});

test("returns the answer, the credit cost and the request id", async (t) => {
  const api = await startApi(() => ({ body: PERSON, headers: headers(3, "req-2") }));
  t.after(api.close);

  const result = await testClient(api.url)({ path: "/v3/person", params: { profile: "jane" } });

  assert.deepEqual(result, { data: PERSON, creditCost: 3, requestId: "req-2" });
});

test("retries 429 and 5xx, then returns the answer", async (t) => {
  const api = await startApi((_request, attempt) =>
    attempt === 1
      ? { status: 429, body: { code: 429, name: "Too Many Requests", description: "Rate limit exceeded" }, headers: { "Retry-After": "0" } }
      : attempt === 2
        ? { status: 503, body: { code: 503, name: "Service Unavailable", description: "Billing service unavailable" } }
        : { body: PERSON, headers: headers(1, "req-3") },
  );
  t.after(api.close);

  const result = await testClient(api.url)({ path: "/v3/person", params: { profile: "jane" } });

  assert.equal(api.requests.length, 3);
  assert.deepEqual(result.data, PERSON);
});

test("stops after two retries and reports the last error", async (t) => {
  const api = await startApi(() => ({
    status: 503,
    body: { code: 503, name: "Service Unavailable", description: "Billing service unavailable" },
    headers: headers(0, "req-4"),
  }));
  t.after(api.close);

  await assert.rejects(testClient(api.url)({ path: "/v3/person", params: { profile: "jane" } }), (error) => {
    assert.ok(error instanceof V3ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.body.description, "Billing service unavailable");
    assert.equal(error.requestId, "req-4");
    return true;
  });
  assert.equal(api.requests.length, 3);
});

test("does not retry other errors", async (t) => {
  const api = await startApi(() => ({
    status: 404,
    body: { code: 404, name: "Not Found", description: "Person not found" },
    headers: headers(0, "req-5"),
  }));
  t.after(api.close);

  await assert.rejects(testClient(api.url)({ path: "/v3/person", params: { profile: "nobody" } }), (error) => {
    assert.ok(error instanceof V3ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.creditCost, 0);
    return true;
  });
  assert.equal(api.requests.length, 1);
});

test("keeps the age of the cached copy from a 409", async (t) => {
  const api = await startApi(() => ({
    status: 409,
    body: { code: 409, name: "Conflict", description: "Freshness conflict", cachedProfileAgeSeconds: 864000 },
  }));
  t.after(api.close);

  await assert.rejects(testClient(api.url)({ path: "/v3/person", params: { profile: "jane", maxAgeSeconds: 60 } }), (error) => {
    assert.ok(error instanceof V3ApiError);
    assert.equal(error.body.cachedProfileAgeSeconds, 864000);
    return true;
  });
  assert.equal(api.requests[0].query.maxAgeSeconds, "60");
});

test("gives up with V3TimeoutError when the API does not answer in time", async (t) => {
  const api = await startApi(() => ({ delayMs: 1_000, body: PERSON }));
  t.after(api.close);

  await assert.rejects(testClient(api.url, { timeoutMs: 100 })({ path: "/v3/person", params: { profile: "jane" } }), V3TimeoutError);
});

test("a call that fetch stops waiting for is a timeout and is not repeated", async (t) => {
  const api = await startApi((_request, attempt) => (attempt === 1 ? { body: PERSON } : { delayMs: 1_500, body: PERSON }));
  t.after(api.close);
  const callV3 = testClient(api.url, { timeoutMs: 5_000 });
  await callV3({ path: "/v3/person", params: { profile: "jane" } });
  const dispatcherKey = Symbol.for("undici.globalDispatcher.1");
  const builtInDispatcher = globalThis[dispatcherKey];
  const shortHeadersWait = new builtInDispatcher.constructor({ headersTimeout: 200 });
  globalThis[dispatcherKey] = shortHeadersWait;
  t.after(async () => {
    globalThis[dispatcherKey] = builtInDispatcher;
    await shortHeadersWait.close();
  });

  await assert.rejects(callV3({ path: "/v3/person", params: { profile: "jane" } }), V3TimeoutError);
  assert.equal(api.requests.length, 2);
});

test("a call cancelled by the user rejects without a timeout error", async (t) => {
  const api = await startApi(() => ({ delayMs: 1_000, body: PERSON }));
  t.after(api.close);
  const controller = new AbortController();

  const call = testClient(api.url)({ path: "/v3/person", params: { profile: "jane" }, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(call, (error) => {
    assert.ok(!(error instanceof V3TimeoutError));
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("fails before any request when ENRICHLAYER_API_KEY is not set", async (t) => {
  const api = await startApi(() => ({ body: PERSON }));
  t.after(api.close);

  await assert.rejects(
    testClient(api.url, { credentials: apiKeyCredentials({ env: {} }) })({ path: "/v3/person", params: { profile: "jane" } }),
    MissingApiKeyError,
  );
  assert.equal(api.requests.length, 0);
});

test("an answer that is not JSON is an error", async (t) => {
  const api = await startApi(() => ({ body: "<html>gateway</html>" }));
  t.after(api.close);

  await assert.rejects(testClient(api.url)({ path: "/v3/person", params: { profile: "jane" } }), V3ApiError);
});

test("an unreachable host is a network error", async () => {
  await assert.rejects(testClient("http://127.0.0.1:1")({ path: "/v3/person", params: { profile: "jane" } }), V3NetworkError);
});

test("names the client in the user agent when it is known", async (t) => {
  const api = await startApi(() => ({ body: PERSON }));
  t.after(api.close);

  await testClient(api.url)({ path: "/v3/person", params: { profile: "jane" }, clientName: "claude-code" });
  await testClient(api.url)({ path: "/v3/person", params: { profile: "jane" }, clientName: "  " });

  assert.equal(api.requests[0].headers["user-agent"], `${USER_AGENT} (claude-code)`);
  assert.equal(api.requests[1].headers["user-agent"], USER_AGENT);
});

test("keeps the client name header-safe", () => {
  assert.equal(userAgentFor("ua/1", "Cursor (beta)\n"), "ua/1 (Cursor beta)");
  assert.equal(userAgentFor("ua/1", "Клиент"), "ua/1");
  assert.equal(userAgentFor("ua/1", undefined), "ua/1");
});
