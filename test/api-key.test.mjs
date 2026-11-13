import { headers, startApi, testClient } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiKeyCredentials } from "../build/auth/api-key.js";

const NO_KEY = {
  name: "MissingApiKeyError",
  message: "No API key. Set ENRICHLAYER_API_KEY or pass --api-key; create a key at https://enrichlayer.com/dashboard.",
};

async function call(t, credentials) {
  const api = await startApi(() => ({ body: {}, headers: headers(0, "req-key") }));
  t.after(api.close);
  const result = testClient(api.url, { credentials })({ path: "/v3/person", params: { profile: "jane" } });
  return { api, result };
}

test("a key from --api-key wins over ENRICHLAYER_API_KEY", async (t) => {
  const credentials = apiKeyCredentials({ flag: "flag-key", env: { ENRICHLAYER_API_KEY: "env-key" } });

  const { api, result } = await call(t, credentials);
  await result;

  assert.equal(credentials.source, "--api-key");
  assert.equal(api.requests[0].headers.authorization, "Bearer flag-key");
});

test("without --api-key the key comes from ENRICHLAYER_API_KEY, trimmed", async (t) => {
  const credentials = apiKeyCredentials({ env: { ENRICHLAYER_API_KEY: " env-key\n" } });

  const { api, result } = await call(t, credentials);
  await result;

  assert.equal(credentials.source, "ENRICHLAYER_API_KEY");
  assert.equal(api.requests[0].headers.authorization, "Bearer env-key");
});

test("no key at all fails before any request", async (t) => {
  const { api, result } = await call(t, apiKeyCredentials({ env: {} }));

  await assert.rejects(result, NO_KEY);
  assert.equal(api.requests.length, 0);
});

test("an empty --api-key is no key, even when ENRICHLAYER_API_KEY is set", async (t) => {
  const { api, result } = await call(t, apiKeyCredentials({ flag: " ", env: { ENRICHLAYER_API_KEY: "env-key" } }));

  await assert.rejects(result, NO_KEY);
  assert.equal(api.requests.length, 0);
});

test("a key with a space is refused before any request, without showing the key", async (t) => {
  const { api, result } = await call(t, apiKeyCredentials({ flag: "secret-part one" }));

  await assert.rejects(result, {
    name: "InvalidApiKeyError",
    message:
      "The API key from --api-key contains a space, a line break or another character an API key cannot have. Copy the key again from https://enrichlayer.com/dashboard.",
  });
  assert.equal(api.requests.length, 0);
});

test("a key with a line break inside comes from ENRICHLAYER_API_KEY in the text", async (t) => {
  const { api, result } = await call(t, apiKeyCredentials({ env: { ENRICHLAYER_API_KEY: "secret\npart" } }));

  await assert.rejects(result, {
    name: "InvalidApiKeyError",
    message:
      "The API key from ENRICHLAYER_API_KEY contains a space, a line break or another character an API key cannot have. Copy the key again from https://enrichlayer.com/dashboard.",
  });
  assert.equal(api.requests.length, 0);
});
