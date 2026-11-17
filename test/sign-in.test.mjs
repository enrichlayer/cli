import { headers, runCli, startApi, startCli, testClient } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withCredentialLock } from "../build/auth/lock.js";
import { browserLogin, deviceLogin, isAllowedIssuer, selectLoginMethod } from "../build/auth/oauth.js";
import { SignInCredentials } from "../build/auth/sign-in.js";
import { CredentialStore } from "../build/auth/token-store.js";
import { V3ApiError } from "../build/client.js";
import { describeFailure } from "../build/errors.js";
import { login, logout, signInStatus } from "../build/sign-in-commands.js";
import { saveKeyFile } from "../build/auth/key-file.js";
import { startIssuer, startRecorder, tempStore } from "./fake-issuer.mjs";

function deps(issuer, { dir, store }, overrides = {}) {
  const printed = [];
  const notes = [];
  return {
    printed,
    notes,
    deps: {
      env: { ENRICHLAYER_AUTH_URL: issuer.url },
      store,
      lockDir: dir,
      say: (line) => printed.push(line),
      keyInUse: () => null,
      note: (line) => notes.push(line),
      open: async () => assert.fail("no browser may be opened"),
      ...overrides,
    },
  };
}

function signIn(issuer, { dir, store }) {
  return new SignInCredentials({ store, lockDir: dir, config: issuer.config() });
}

/** A browser that follows the authorization link and is sent back to the CLI's callback. */
function browser(issuer, seen, { state, iss, answer } = {}) {
  return async (link) => {
    const url = new URL(link);
    seen.push(url);
    await fetch(url);
    const callback = new URL(url.searchParams.get("redirect_uri"));
    const given = answer ?? { code: "auth-code" };
    callback.search = new URLSearchParams({ ...given, state: state ?? url.searchParams.get("state"), iss: iss ?? issuer.url }).toString();
    await (await fetch(callback)).text();
  };
}

const folder = (home) => join(home, ".config", "enrichlayer-v3");

/** Run the CLI with this HOME and no XDG_CONFIG_HOME, so the key file and the sign-in sit in ~/.config/enrichlayer-v3. */
const cliIn = (home, args, env = {}) => runCli(args, { home, xdg: null, env });

function emptyHome(t) {
  const home = mkdtempSync(join(tmpdir(), "enrichlayer-cli-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A HOME whose file store already holds the issuer's current pair. */
async function signedInHome(t, issuer, expiresInMs) {
  const home = emptyHome(t);
  await new CredentialStore(folder(home)).write(issuer.tokens(expiresInMs));
  return home;
}

test("A: a given or saved API key wins over a stored sign-in, with the same header and the same texts as before", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer);
  const api = await startApi((request) =>
    request.query.profile === "rejected" ? { status: 401, body: { description: "Invalid API key" }, headers: headers(0, "req-401") } : { body: {}, headers: headers(1, "req-1") },
  );
  t.after(api.close);
  const env = { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url };

  const signedIn = await cliIn(home, ["person", "--profile", "jane"], env);
  const fromEnv = await cliIn(home, ["person", "--profile", "jane"], { ...env, ENRICHLAYER_API_KEY: "test-key" });
  const fromFlag = await cliIn(home, ["person", "--profile", "jane", "--api-key", "flag-key"], env);
  const rejected = await cliIn(home, ["person", "--profile", "rejected"], { ...env, ENRICHLAYER_API_KEY: "test-key" });
  saveKeyFile(join(folder(home), "credentials.json"), "file-key");
  const fromFile = await cliIn(home, ["person", "--profile", "jane"], env);

  assert.deepEqual([signedIn.code, fromEnv.code, fromFlag.code, fromFile.code], [0, 0, 0, 0]);
  assert.deepEqual(
    api.requests.map((r) => r.headers.authorization),
    [`Bearer ${issuer.state.accessToken}`, "Bearer test-key", "Bearer flag-key", "Bearer test-key", "Bearer file-key"],
  );
  assert.equal(
    rejected.stderr,
    "error: The API key from ENRICHLAYER_API_KEY was rejected: Invalid API key. Use a valid key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-401)\n",
  );
  assert.equal(issuer.state.requests.length, 0, "a call with a key never talks to the issuer");
});

test("A: a key file that cannot be used stops the call; it does not hand over to the sign-in", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const file = join(folder(home), "credentials.json");
  writeFileSync(file, "{", { mode: 0o600 });

  const call = await cliIn(home, ["company-search", "--q", "acme"], { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url });

  assert.deepEqual(
    [call.code, call.stderr],
    [3, `error: The key file ${file} is not valid. Save the key again with enrichlayer-v3 auth save, or remove it with enrichlayer-v3 auth remove.\n`],
  );
  assert.equal(api.requests.length, 0);
});

test("A: an empty ENRICHLAYER_API_KEY counts as unset: the key file is used, and without one the sign-in", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const env = (value) => ({ ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url, ENRICHLAYER_API_KEY: value });

  const results = [];
  for (const value of ["", "  "]) results.push(await cliIn(home, ["company-search", "--q", "acme"], env(value)));
  saveKeyFile(join(folder(home), "credentials.json"), "file-key");
  for (const value of ["", "  "]) results.push(await cliIn(home, ["company-search", "--q", "acme"], env(value)));

  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0]);
  const signedIn = `Bearer ${issuer.state.accessToken}`;
  assert.deepEqual(api.requests.map((r) => r.headers.authorization), [signedIn, signedIn, "Bearer file-key", "Bearer file-key"]);
});

test("B: browser login uses PKCE S256 and a 127.0.0.1 callback, checks state and stores the tokens", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const seen = [];
  const { deps: d, printed, notes } = deps(issuer, local, { method: () => "browser", open: browser(issuer, seen) });

  await login(false, d);

  const link = seen[0];
  assert.equal(link.origin + link.pathname, `${issuer.url}/auth`);
  assert.equal(link.searchParams.get("code_challenge_method"), "S256");
  assert.match(link.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.deepEqual(
    ["client_id", "resource", "scope", "response_type"].map((name) => link.searchParams.get(name)),
    ["enrichlayer-cli", "https://api.enrichlayer.com", "api", "code"],
  );
  assert.ok(notes.some((line) => line.includes(link.toString())), "the link is printed in case the browser does not open");
  assert.equal(issuer.tokenRequests("authorization_code")[0].params.get("code_verifier").length, 43);
  assert.deepEqual((await local.store.read()).refreshToken, "refresh-0");
  assert.deepEqual(printed, ["Signed in: account account-123, client enrichlayer-cli, grant grant-1."]);
});

test("B: a callback with a wrong state is refused and nothing is stored", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const { deps: d, printed } = deps(issuer, local, { method: () => "browser", open: browser(issuer, [], { state: "forged" }) });

  await assert.rejects(login(false, d), { name: "OAuthError", message: /does not belong to this login/ });

  assert.equal(await local.store.read(), null);
  assert.equal(issuer.tokenRequests().length, 0, "the code is not exchanged");
  assert.deepEqual(printed, []);
});

test("B: a callback from another issuer is refused and nothing is stored", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const { deps: d } = deps(issuer, local, { method: () => "browser", open: browser(issuer, [], { iss: "https://elsewhere.example" }) });

  await assert.rejects(login(false, d), { name: "OAuthError", message: /does not belong to this login/ });

  assert.equal(await local.store.read(), null);
  assert.equal(issuer.tokenRequests().length, 0);
});

test("B: a callback that says access_denied reports a declined sign-in and stores nothing", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const { deps: d } = deps(issuer, local, { method: () => "browser", open: browser(issuer, [], { answer: { error: "access_denied" } }) });

  await assert.rejects(login(false, d), { name: "OAuthError", message: "Sign-in was declined in the browser. Nothing was saved." });

  assert.equal(await local.store.read(), null);
  assert.equal(issuer.tokenRequests().length, 0);
});

test("B: only the first callback is answered; a second one gets 410", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const statuses = [];
  let browsing;
  const follow = async (link) => {
    const url = new URL(link);
    await fetch(url);
    const callback = new URL(url.searchParams.get("redirect_uri"));
    const query = new URLSearchParams({ code: "auth-code", state: url.searchParams.get("state"), iss: issuer.url });
    // Two connections, both accepted before the first callback closes the listener.
    const sockets = await Promise.all(
      [0, 1].map(() => new Promise((resolve) => { const socket = connect(Number(callback.port), "127.0.0.1", () => resolve(socket)); })),
    );
    const answers = sockets.map(
      (socket) =>
        new Promise((resolve) => {
          let text = "";
          socket.on("data", (chunk) => (text += chunk));
          socket.on("close", () => resolve(Number(text.split(" ")[1])));
        }),
    );
    for (const socket of sockets) socket.write(`GET /callback?${query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    statuses.push(...(await Promise.all(answers)));
  };
  // login returns once the first code arrives; the browser still has to read both answers.
  const open = (link) => (browsing = follow(link));
  const { deps: d } = deps(issuer, local, { method: () => "browser", open });

  await login(false, d);
  await browsing;

  assert.deepEqual(statuses.sort((a, b) => a - b), [200, 410]);
  assert.equal(issuer.tokenRequests("authorization_code").length, 1);
});

test("C: device login shows the code and the plain link, never opens a link and never shows one with the code in it", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const { deps: d, notes, printed } = deps(issuer, local, { device: (config, options) => deviceLogin(config, { ...options, wait: async () => {} }) });

  await login(true, d);

  assert.deepEqual(notes, [`To sign in, open ${issuer.url}/device in a browser and enter the code ABCD-EFGH`]);
  assert.equal(notes.join("\n").includes("user_code="), false);
  assert.equal((await local.store.read()).accessToken, issuer.state.accessToken);
  assert.deepEqual(printed, ["Signed in: account account-123, client enrichlayer-cli, grant grant-1."]);
});

test("C: device polling waits longer after slow_down and goes on after authorization_pending", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.deviceErrors = ["authorization_pending", "slow_down", "authorization_pending"];
  const waits = [];

  const tokens = await deviceLogin(issuer.config(), { onCode: () => {}, wait: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [5000, 5000, 10000, 10000]);
  assert.equal(tokens.refreshToken, "refresh-0");
  assert.equal(issuer.tokenRequests().some((r) => r.params.has("resource")), false);
});

test("C: device polling never goes below 5 s, the RFC 8628 default", async (t) => {
  for (const [interval, first] of [
    [1, 5000],
    [undefined, 5000],
    [0, 5000],
    [7, 7000],
  ]) {
    const issuer = await startIssuer(t);
    issuer.state.deviceInterval = interval;
    const waits = [];

    await deviceLogin(issuer.config(), { onCode: () => {}, wait: async (ms) => waits.push(ms) });

    assert.deepEqual(waits, [first], String(interval));
  }
});

test("C: an issuer error code is printed without control characters and cut short", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.deviceErrors = [`\u001b[31mbad\ncode${"x".repeat(300)}`];

  const error = await deviceLogin(issuer.config(), { onCode: () => {}, wait: async () => {} }).catch((e) => e);

  assert.equal(error.message, `Sign-in failed: [31mbadcode${"x".repeat(100 - "[31mbadcode".length)}`);
});

test("C: device polling stops at expired_token and at access_denied", async (t) => {
  for (const [error, message] of [
    ["expired_token", /code expired/],
    ["access_denied", /declined/],
  ]) {
    const issuer = await startIssuer(t);
    issuer.state.deviceErrors = ["authorization_pending", error, "authorization_pending"];

    await assert.rejects(deviceLogin(issuer.config(), { onCode: () => {}, wait: async () => {} }), { name: "OAuthError", message });

    assert.equal(issuer.tokenRequests().length, 2, error);
  }
});

test("C: a device answer with another verification link is refused before any code is shown", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.verificationUri = "https://elsewhere.example/device";
  const shown = [];

  await assert.rejects(deviceLogin(issuer.config(), { onCode: (code) => shown.push(code), wait: async () => {} }), /unexpected verification link/);

  assert.deepEqual(shown, []);
});

test("D: two processes refreshing at once use the refresh token once", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.refreshDelayMs = 200;
  const local = tempStore(t);
  await local.store.write(issuer.tokens(30_000));

  const [first, second] = await Promise.all([signIn(issuer, local).authorization(), signIn(issuer, local).authorization()]);

  assert.equal(issuer.state.refreshCount, 1);
  assert.equal(issuer.state.revoked, false);
  assert.deepEqual([first, second], [`Bearer ${issuer.state.accessToken}`, `Bearer ${issuer.state.accessToken}`]);
  assert.equal((await local.store.read()).refreshToken, "refresh-1");
});

test("E: a 401 is followed by one refresh and one retry", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  await local.store.write(issuer.tokens());
  const api = await startApi((request, n) =>
    n === 1 || request.headers.authorization !== `Bearer ${issuer.state.accessToken}` ? { status: 401, body: { description: "Token revoked" } } : { body: { ok: true } },
  );
  t.after(api.close);

  const result = await testClient(api.url, { credentials: signIn(issuer, local) })({ path: "/v3/person", params: { profile: "jane" } });

  assert.deepEqual(result.data, { ok: true });
  assert.equal(issuer.state.refreshCount, 1);
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[1].headers.authorization, `Bearer ${issuer.state.accessToken}`);
});

test("E: a 401 after the refresh is the answer, not a loop", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  await local.store.write(issuer.tokens());
  const api = await startApi(() => ({ status: 401, body: { description: "Token revoked" }, headers: headers(0, "req-401") }));
  t.after(api.close);

  const call = testClient(api.url, { credentials: signIn(issuer, local) })({ path: "/v3/person", params: { profile: "jane" } });

  const error = await call.catch((e) => e);
  assert.ok(error instanceof V3ApiError && error.status === 401);
  assert.equal(api.requests.length, 2);
  assert.equal(issuer.state.refreshCount, 1);
  assert.equal(
    describeFailure(error, { keySource: "the stored sign-in", hasMaxAgeSeconds: false }).message,
    "The stored sign-in was rejected: Token revoked. Run enrichlayer-v3 auth login to sign in again. (credits charged: 0, request id: req-401)",
  );
});

test("E: the client retries once even when the credentials would offer a new header every time", async (t) => {
  const api = await startApi(() => ({ status: 401, body: { description: "Token revoked" } }));
  t.after(api.close);
  let offered = 0;
  const credentials = { source: "the stored sign-in", authorization: async () => "Bearer t-0", refreshAfter401: async () => `Bearer t-${++offered}` };

  await assert.rejects(testClient(api.url, { credentials })({ path: "/v3/person", params: { profile: "jane" } }), V3ApiError);

  assert.equal(offered, 1);
  assert.deepEqual(api.requests.map((r) => r.headers.authorization), ["Bearer t-0", "Bearer t-1"]);
});

test("E: a token this process has just been given is not refreshed again after a 401", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  await local.store.write(issuer.tokens(1_000));
  const credentials = signIn(issuer, local);

  const header = await credentials.authorization();

  assert.equal(await credentials.refreshAfter401(header), null);
  assert.equal(issuer.state.refreshCount, 1);
});

test("F: logout revokes the refresh token and deletes the sign-in", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  await local.store.write(issuer.tokens());
  const { deps: d, printed } = deps(issuer, local);

  await logout(d);

  const revocation = issuer.state.requests.find((r) => r.path === "/token/revocation");
  assert.deepEqual([revocation.params.get("token"), revocation.params.get("token_type_hint")], ["refresh-0", "refresh_token"]);
  assert.equal(await local.store.read(), null);
  assert.deepEqual(printed, ["Signed out: the sign-in is revoked and deleted."]);
});

test("F: logout deletes the sign-in even when the revocation fails or the issuer is down", async (t) => {
  for (const down of [false, true]) {
    const issuer = await startIssuer(t);
    issuer.state.revokeStatus = 503;
    const local = tempStore(t);
    await local.store.write(issuer.tokens());
    if (down) await issuer.close();
    const { deps: d, printed, notes } = deps(issuer, local);

    await logout(d);

    assert.equal(await local.store.read(), null, down ? "issuer down" : "503");
    assert.deepEqual(printed, ["Signed out: the sign-in is deleted."]);
    assert.match(notes[0], /did not confirm that the sign-in was revoked; the local copy is deleted/);
  }
});

test("G: auth status shows the account, client, grant and whether the sign-in is in use, and no token", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  await local.store.write(issuer.tokens());
  const { deps: d, printed } = deps(issuer, local);

  const inUse = await signInStatus(d);
  const behindKey = await signInStatus({ ...d, keyInUse: () => "ENRICHLAYER_API_KEY" });

  assert.deepEqual([inUse, behindKey], [true, false]);
  assert.equal(printed.length, 2);
  assert.match(printed[0], /^Sign-in: account account-123, client enrichlayer-cli, grant grant-1, access token valid until \d{4}-\d\d-\d\dT[\d:.]+Z \(in use\)$/);
  assert.match(printed[1], /\(not in use: ENRICHLAYER_API_KEY takes precedence\)$/);
  const text = printed.join("\n");
  for (const secret of [issuer.state.accessToken, issuer.state.accessToken.split(".")[2], "refresh-0"]) assert.equal(text.includes(secret), false, secret);
});

test("G: auth status and a failed call print no token on the command line", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer, 1_000);
  const { accessToken, refreshToken } = issuer.state;
  issuer.state.revoked = true;
  const api = await startApi(() => ({ status: 401, body: { description: "Token revoked" } }));
  t.after(api.close);
  const env = { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url };
  const file = join(folder(home), "credentials.json");

  const status = await cliIn(home, ["auth", "status"], env);
  const call = await cliIn(home, ["person", "--profile", "jane"], env);

  assert.equal(status.code, 0);
  assert.equal(status.stderr, "");
  const [key, keyFile, signIn] = status.stdout.split("\n");
  assert.deepEqual([key, keyFile], ["Key in use: none", `Key file: ${file} (not saved)`]);
  assert.match(signIn, /^Sign-in: account account-123, client enrichlayer-cli, grant grant-1, access token valid until .* \(in use\)$/);
  assert.deepEqual([call.code, call.stdout, call.stderr], [3, "", "error: The sign-in has expired or was revoked. Run enrichlayer-v3 auth login to sign in again.\n"]);
  assert.equal(api.requests.length, 0);
  const printed = status.stdout + status.stderr + call.stdout + call.stderr;
  for (const secret of [accessToken, accessToken.split(".")[2], refreshToken]) assert.equal(printed.includes(secret), false, secret);
});

test("--dry-run with a stored sign-in names the sign-in instead of the token", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer);

  const result = await cliIn(home, ["company-search", "--q", "acme", "--dry-run"], { ENRICHLAYER_AUTH_URL: issuer.url });

  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).headers.Authorization, "Bearer <the stored sign-in>");
  assert.equal(result.stdout.includes(issuer.state.accessToken), false);
});

test("auth logout and auth status without any key or sign-in", async (t) => {
  const home = emptyHome(t);
  const file = join(folder(home), "credentials.json");

  const out = await cliIn(home, ["auth", "logout"]);
  const status = await cliIn(home, ["auth", "status"]);
  const call = await cliIn(home, ["company-search", "--q", "acme"]);

  assert.deepEqual([out.code, out.stdout, out.stderr], [0, "No stored sign-in.\n", ""]);
  assert.equal(existsSync(join(folder(home), "session.json")), false);
  assert.deepEqual([status.code, status.stdout], [3, `Key in use: none\nKey file: ${file} (not saved)\n`]);
  assert.match(call.stderr, /^error: Not signed in and no API key\. Sign in with enrichlayer-v3 auth login, or save a key with enrichlayer-v3 auth save/);
});

test("the sign-in file is session.json beside the key file, readable by its owner only", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer);
  const dir = folder(home);

  assert.equal(statSync(join(dir, "session.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the login method is chosen as the v2 CLI chooses it", () => {
  const base = { platform: "darwin", noBrowser: false, env: {}, docker: false, procVersion: "" };
  const cases = [
    [{}, "browser"],
    [{ noBrowser: true }, "device"],
    [{ env: { SSH_CONNECTION: "1" } }, "device"],
    [{ env: { CI: "true" } }, "device"],
    [{ docker: true }, "device"],
    [{ platform: "linux" }, "device"],
    [{ platform: "linux", env: { DISPLAY: ":0" } }, "browser"],
    [{ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }, "windows"],
    [{ platform: "win32" }, "browser"],
  ];
  for (const [given, method] of cases) assert.equal(selectLoginMethod({ ...base, ...given }), method, JSON.stringify(given));
});

test("--dry-run with a stored sign-in that is about to expire does not refresh it", async (t) => {
  const issuer = await startIssuer(t);
  const home = await signedInHome(t, issuer, 1_000);

  const result = await cliIn(home, ["company-search", "--q", "acme", "--dry-run"], { ENRICHLAYER_AUTH_URL: issuer.url });

  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).headers.Authorization, "Bearer <the stored sign-in>");
  assert.equal(issuer.state.requests.length, 0);
  const stored = await new CredentialStore(folder(home)).read();
  assert.equal(stored.refreshToken, "refresh-0");
});

test("a lock whose holder has exited is broken at once; a live or still unwritten one is waited for, and the wait is shown only after a second", async (t) => {
  const { dir } = tempStore(t);
  const lock = join(dir, "session.lock");
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const waits = [];

  writeFileSync(lock, String(exited));
  const started = Date.now();
  assert.equal(await withCredentialLock(dir, async () => "got it", 120_000, 2_000, (path) => waits.push(path)), "got it");
  assert.ok(Date.now() - started < 1_000);

  const failures = [];
  for (const [holder, waitMs] of [
    [String(process.pid), 1_200],
    ["", 600],
  ]) {
    writeFileSync(lock, holder);
    failures.push(await withCredentialLock(dir, async () => "got it", 120_000, waitMs, (path) => waits.push(path)).catch((error) => error));
  }
  const timedOut = ["SignInUnavailableError", `Another enrichlayer-v3 process has held ${lock} for 1 s. Try again in a minute.`];
  assert.deepEqual(
    failures.map((error) => [error.name, error.message]),
    [timedOut, timedOut],
  );
  assert.equal(describeFailure(failures[0], { keySource: "the stored sign-in", hasMaxAgeSeconds: false }).exitCode, 5);
  assert.deepEqual(waits, [lock], "one line, and only for a wait longer than a second");
});

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

const CALL = ["company-search", "--q", "acme"];
const NOT_REGULAR = (file) => `error: The sign-in file ${file} is not a regular file. Remove it and sign in again with enrichlayer-v3 auth login.\n`;
const DAMAGED = () => "error: The stored sign-in is damaged. Run enrichlayer-v3 auth login.\n";

test("a sign-in file that others can read, a link, a FIFO or a damaged one stops the call with exit code 3 and sends nothing", { timeout: 30_000 }, async (t) => {
  const issuer = await startIssuer(t);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const env = { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url };
  const cases = [
    [(file) => chmodSync(file, 0o644), (file) => `error: The sign-in file ${file} can be read by other users (mode 0644). Run chmod 600 ${file}, or sign in again with enrichlayer-v3 auth login.\n`],
    [(file, home) => (renameSync(file, join(home, "elsewhere.json")), symlinkSync(join(home, "elsewhere.json"), file)), NOT_REGULAR],
    [(file) => (unlinkSync(file), spawnSync("mkfifo", [file])), NOT_REGULAR],
    [(file) => writeFileSync(file, "{"), DAMAGED],
    [(file) => writeFileSync(file, JSON.stringify({ ...issuer.tokens(), accessToken: 7 })), DAMAGED],
    [(file) => writeFileSync(file, JSON.stringify({ ...issuer.tokens(), issuer: "http://auth.example.com" })), DAMAGED],
  ];

  const results = [];
  for (const [spoil, message] of cases) {
    const home = await signedInHome(t, issuer);
    const file = join(folder(home), "session.json");
    spoil(file, home);
    const call = await cliIn(home, CALL, env);
    results.push([[call.code, call.stdout, call.stderr], [3, "", message(file)]]);
  }

  assert.deepEqual(
    results.map(([got]) => got),
    results.map(([, expected]) => expected),
  );
  assert.deepEqual([api.requests.length, issuer.state.requests.length], [0, 0]);
});

test("auth logout revokes and deletes a sign-in file others can read, and deletes a link or a damaged file without revoking", async (t) => {
  const issuer = await startIssuer(t);
  const env = { ENRICHLAYER_AUTH_URL: issuer.url };
  const exposed = await signedInHome(t, issuer);
  chmodSync(join(folder(exposed), "session.json"), 0o644);
  const linked = await signedInHome(t, issuer);
  const target = join(linked, "elsewhere.json");
  renameSync(join(folder(linked), "session.json"), target);
  symlinkSync(target, join(folder(linked), "session.json"));
  const damaged = await signedInHome(t, issuer);
  writeFileSync(join(folder(damaged), "session.json"), "{");

  const results = [];
  for (const home of [exposed, linked, damaged]) results.push(await cliIn(home, ["auth", "logout"], env));

  const deleted = [0, "Signed out: the sign-in file could not be used and is deleted; nothing was revoked.\n", ""];
  assert.deepEqual(
    results.map((r) => [r.code, r.stdout, r.stderr]),
    [[0, "Signed out: the sign-in is revoked and deleted.\n", ""], deleted, deleted],
  );
  assert.deepEqual(
    issuer.state.requests.filter((r) => r.path === "/token/revocation").map((r) => r.params.get("token")),
    ["refresh-0"],
  );
  assert.deepEqual(
    [exposed, linked, damaged].map((home) => existsSync(join(folder(home), "session.json"))),
    [false, false, false],
  );
  assert.equal(readFileSync(target, "utf8").includes("refresh-0"), true);
});

test("a refresh exits with 5 when the sign-in server cannot be reached, fails or sends an answer that cannot be read, and with 3 when the sign-in was revoked", async (t) => {
  const results = [];
  for (const failure of ["drop", 503, "html", "revoked"]) {
    const issuer = await startIssuer(t);
    const home = await signedInHome(t, issuer, 1_000);
    if (failure === "revoked") issuer.state.revoked = true;
    else issuer.state.refreshFailure = failure;
    const api = await startApi(() => ({ body: {} }));
    t.after(api.close);

    const call = await cliIn(home, CALL, { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url });

    results.push({ got: [call.code, call.stderr, api.requests.length], url: issuer.url });
  }

  assert.deepEqual(
    results.map(({ got }) => got),
    [
      [5, `error: Could not reach the sign-in server ${results[0].url}. Try again in a few minutes.\n`, 0],
      [5, `error: The sign-in server ${results[1].url} is not available right now (HTTP 503). Try again in a few minutes.\n`, 0],
      [5, "error: The sign-in server sent an answer that could not be read. Try again in a few minutes.\n", 0],
      [3, "error: The sign-in has expired or was revoked. Run enrichlayer-v3 auth login to sign in again.\n", 0],
    ],
  );
});

test("device polling goes on after a broken connection, a 503 or an answer that cannot be read", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.deviceErrors = ["drop", "503", "html", "authorization_pending"];
  const waits = [];

  const tokens = await deviceLogin(issuer.config(), { onCode: () => {}, wait: async (ms) => waits.push(ms) });

  assert.deepEqual(waits, [5000, 5000, 5000, 5000, 5000]);
  assert.equal(tokens.refreshToken, "refresh-0");
});

test("Ctrl-C while the sign-in is renewed waits until the new pair is stored and the lock released, then exits with 130", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.refreshDelayMs = 1_000;
  const home = await signedInHome(t, issuer, 1_000);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const env = { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url };

  const { child, done } = startCli(CALL, { home, xdg: null, env });
  while (issuer.state.refreshCount === 0) await sleep(10);
  child.kill("SIGINT");
  child.kill("SIGINT");
  const interrupted = await done;
  issuer.state.refreshDelayMs = 0;
  const stored = await new CredentialStore(folder(home)).read();
  const next = await cliIn(home, CALL, env);

  assert.equal(interrupted.code, 130);
  assert.deepEqual([stored.refreshToken, issuer.state.revoked, existsSync(join(folder(home), "session.lock"))], ["refresh-1", false, false]);
  assert.equal(next.code, 0);
  assert.deepEqual(
    api.requests.map((r) => r.headers.authorization),
    [`Bearer ${issuer.state.accessToken}`],
  );
});

test("the browser login listens on 127.0.0.1 only", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const external = Object.values(networkInterfaces())
    .flat()
    .find((address) => address.family === "IPv4" && !address.internal)?.address;
  const hosts = external ? ["::1", external] : ["::1"];
  const reached = [];
  const follow = browser(issuer, []);
  const open = async (link) => {
    const port = Number(new URL(new URL(link).searchParams.get("redirect_uri")).port);
    for (const host of hosts) reached.push([host, await canConnect(host, port)]);
    await follow(link);
  };
  const { deps: d } = deps(issuer, local, { method: () => "browser", open });

  await login(false, d);

  assert.deepEqual(
    reached,
    hosts.map((host) => [host, false]),
  );
});

test("a stored sign-in is not used, and nothing is sent, after ENRICHLAYER_AUTH_URL, ENRICHLAYER_CLIENT_ID or ENRICHLAYER_RESOURCE changes", async (t) => {
  const issuer = await startIssuer(t);
  const other = await startRecorder(t);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const base = { ENRICHLAYER_AUTH_URL: issuer.url, ENRICHLAYER_API_BASE_URL: api.url };

  const results = [];
  for (const change of [{ ENRICHLAYER_AUTH_URL: other.url }, { ENRICHLAYER_CLIENT_ID: "another-client" }, { ENRICHLAYER_RESOURCE: "https://api.example.com" }]) {
    const home = await signedInHome(t, issuer, 1_000);
    const call = await cliIn(home, CALL, { ...base, ...change });
    results.push([call.code, call.stdout, call.stderr]);
  }

  const refused = [3, "", "error: The stored sign-in is for another sign-in server, client or API. Run enrichlayer-v3 auth login.\n"];
  assert.deepEqual(results, [refused, refused, refused]);
  assert.deepEqual([other.requests.length, issuer.state.requests.length, api.requests.length], [0, 0, 0]);
});

test("a request to another path of the browser login listener gets 404 and does not end the login", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const statuses = [];
  const follow = browser(issuer, []);
  const open = async (link) => {
    const callback = new URL(new URL(link).searchParams.get("redirect_uri"));
    const stray = await fetch(`${callback.origin}/favicon.ico`);
    statuses.push(stray.status);
    await stray.text();
    await follow(link);
  };
  const { deps: d, printed } = deps(issuer, local, { method: () => "browser", open });

  await login(false, d);

  assert.deepEqual(statuses, [404]);
  assert.deepEqual(printed, ["Signed in: account account-123, client enrichlayer-cli, grant grant-1."]);
});

test("ENRICHLAYER_AUTH_URL must be https, or http on 127.0.0.1, localhost or ::1", async (t) => {
  const urls = [
    ["https://auth.example.com", true],
    ["http://127.0.0.1:8080", true],
    ["http://localhost:9", true],
    ["http://[::1]:9", true],
    ["http://auth.example.com", false],
    ["ftp://auth.example.com", false],
    ["auth.example.com", false],
  ];
  const home = emptyHome(t);

  const result = await cliIn(home, ["auth", "login", "--no-browser"], { ENRICHLAYER_AUTH_URL: "http://auth.example.com" });

  assert.deepEqual(
    urls.map(([url]) => [url, isAllowedIssuer(url)]),
    urls,
  );
  assert.deepEqual([result.code, result.stdout, result.stderr], [3, "", "error: ENRICHLAYER_AUTH_URL must start with https:// (http:// only for 127.0.0.1, localhost or ::1).\n"]);
});

test("a redirect from the sign-in server is not followed", async (t) => {
  const issuer = await startIssuer(t);
  const sink = await startRecorder(t);
  const redirector = await startRecorder(t, sink.url);
  const api = await startApi(() => ({ body: {} }));
  t.after(api.close);
  const home = emptyHome(t);
  await new CredentialStore(folder(home)).write({ ...issuer.tokens(1_000), issuer: redirector.url });

  const call = await cliIn(home, CALL, { ENRICHLAYER_AUTH_URL: redirector.url, ENRICHLAYER_API_BASE_URL: api.url });

  assert.deepEqual(
    [call.code, call.stderr],
    [3, `error: The sign-in server ${redirector.url} answered with a redirect, which the CLI does not follow. Check ENRICHLAYER_AUTH_URL.\n`],
  );
  assert.deepEqual([redirector.requests.map((r) => r.path), sink.requests.length, api.requests.length], [["/token"], 0, 0]);
});

test("a lock older than a minute is broken whoever holds it, and one without a pid after ten seconds", async (t) => {
  const { dir } = tempStore(t);
  const lock = join(dir, "session.lock");

  const got = [];
  for (const [holder, ageMs] of [
    [String(process.pid), 61_000],
    ["", 11_000],
  ]) {
    writeFileSync(lock, holder);
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(lock, when, when);
    got.push(await withCredentialLock(dir, async () => "got it", undefined, 500, () => {}));
  }

  assert.deepEqual(got, ["got it", "got it"]);
});

test("access denied tells a signed-in user to contact support, and a key user what it told them before", () => {
  const error = new V3ApiError("/v3/person", 403, { description: "Forbidden" }, 0, "req-403");

  const messages = ["the stored sign-in", "ENRICHLAYER_API_KEY"].map((keySource) => describeFailure(error, { keySource, hasMaxAgeSeconds: false }).message);

  assert.deepEqual(messages, [
    "Access denied for /v3/person: Forbidden. The signed-in account cannot use this endpoint; contact support@enrichlayer.com. (credits charged: 0, request id: req-403)",
    "Access denied for /v3/person: Forbidden. This key or its account cannot use this endpoint; use a key that can, or contact support@enrichlayer.com. (credits charged: 0, request id: req-403)",
  ]);
});

test("auth status says when the access token expired and that the next call renews it", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const tokens = issuer.tokens(-60_000);
  await local.store.write(tokens);
  const { deps: d, printed } = deps(issuer, local);

  await signInStatus(d);

  assert.deepEqual(printed, [
    `Sign-in: account account-123, client enrichlayer-cli, grant grant-1, access token expired at ${new Date(tokens.expiresAt).toISOString()}, renewed on the next call (in use)`,
  ]);
});

test("the browser login gives up when its time runs out", async (t) => {
  const issuer = await startIssuer(t);

  await assert.rejects(browserLogin(issuer.config(), { open: async () => {}, onUrl: () => {}, timeoutMs: 50 }), {
    name: "OAuthError",
    message: "The browser sign-in was not completed within 10 minutes. To use a link and a code instead, run: enrichlayer-v3 auth login --no-browser",
  });
});

test("device polling stops when the code expires or after ten minutes, and then names the last failure to reach the server", async (t) => {
  const results = [];
  for (const [expiresIn, poll] of [
    [60, "authorization_pending"],
    [900, "authorization_pending"],
    [30, "drop"],
  ]) {
    const issuer = await startIssuer(t);
    issuer.state.deviceExpiresIn = expiresIn;
    issuer.state.deviceErrors = Array(200).fill(poll);
    let clock = 0;

    const error = await deviceLogin(issuer.config(), {
      onCode: () => {},
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    }).catch((failure) => failure);

    results.push({ got: [clock, error.message], url: issuer.url });
  }

  const notApproved = "The code was not approved within 10 minutes. Run enrichlayer-v3 auth login again.";
  assert.deepEqual(
    results.map(({ got }) => got),
    [
      [60_000, notApproved],
      [600_000, notApproved],
      [30_000, `Could not reach the sign-in server ${results[2].url}. Try again in a few minutes.`],
    ],
  );
});

test("auth login writes the sign-in only after another process has released the lock", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  const held = withCredentialLock(local.dir, async () => {
    await sleep(300);
    await local.store.write({ ...issuer.tokens(), refreshToken: "held-pair" });
  });
  const { deps: d } = deps(issuer, local, { device: (config, options) => deviceLogin(config, { ...options, wait: async () => {} }) });

  await login(true, d);
  await held;

  assert.equal((await local.store.read()).refreshToken, "refresh-0");
});

test("the device code from the sign-in server is shown without control characters", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.userCode = "\u001b[31mABCD\n-EFGH\u0007";
  const shown = [];

  await deviceLogin(issuer.config(), { onCode: (code) => shown.push(code.userCode), wait: async () => {} });

  assert.deepEqual(shown, ["[31mABCD-EFGH"]);
});

test("after a refresh that did not complete, the same process does not present the refresh token again", async (t) => {
  const issuer = await startIssuer(t);
  issuer.state.refreshFailure = "drop";
  const local = tempStore(t);
  await local.store.write(issuer.tokens(1_000));
  const credentials = signIn(issuer, local);

  const first = await credentials.authorization().catch((error) => error);
  issuer.state.refreshFailure = undefined;
  const second = await credentials.authorization().catch((error) => error);

  assert.deepEqual(
    [first.name, second.message, issuer.state.refreshCount],
    ["SignInUnavailableError", "An earlier refresh of the sign-in did not complete. Run enrichlayer-v3 auth login.", 1],
  );
});

test("writing the sign-in replaces a file others can read and a link with a new private file, and leaves the link's target alone", async (t) => {
  const issuer = await startIssuer(t);
  const local = tempStore(t);
  writeFileSync(local.store.file, "{}");
  chmodSync(local.store.file, 0o644);
  await local.store.write(issuer.tokens());
  const mode = statSync(local.store.file).mode & 0o777;
  const target = join(local.dir, "target.json");
  writeFileSync(target, "keep");
  rmSync(local.store.file);
  symlinkSync(target, local.store.file);

  await local.store.write(issuer.tokens());

  assert.deepEqual([mode, lstatSync(local.store.file).isFile(), readFileSync(target, "utf8")], [0o600, true, "keep"]);
});
