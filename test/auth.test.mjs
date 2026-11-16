import { headers, runCli, startApi, tempDir } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = "sk-cli-test-7f3k2q9x";
const NO_CREDENTIAL =
  "error: Not signed in and no API key. Sign in with enrichlayer-v3 auth login, or save a key with enrichlayer-v3 auth save, set ENRICHLAYER_API_KEY or pass --api-key; create a key at https://enrichlayer.com/dashboard.\n";

async function setUp(t, respond = () => ({ body: [{ companyName: "Acme" }], headers: headers(0, "req-auth") })) {
  const api = await startApi(respond);
  t.after(api.close);
  const home = tempDir(t);
  const file = join(home, ".config", "enrichlayer-v3", "credentials.json");
  const cli = (args, { input, env = {} } = {}) => runCli(args, { home, xdg: null, input, env: { ENRICHLAYER_API_BASE_URL: api.url, ...env } });
  return { api, home, file, cli };
}

const outcome = ({ code, stdout, stderr }) => ({ code, stdout, stderr });

test("auth save, a call with the saved key, auth status, auth remove, and then no key", async (t) => {
  const { api, file, cli } = await setUp(t);

  const saved = await cli(["auth", "save"], { input: `${KEY}\n` });
  const call = await cli(["company-search", "--q", "acme"]);
  const status = await cli(["auth", "status"]);
  const removed = await cli(["auth", "remove"]);
  const afterRemove = await cli(["company-search", "--q", "acme"]);
  const statusAfter = await cli(["auth", "status"]);
  const removedAgain = await cli(["auth", "remove"]);

  assert.deepEqual(outcome(saved), { code: 0, stdout: `Saved the API key to ${file}.\n`, stderr: "" });
  assert.equal(call.code, 0);
  assert.equal(api.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(outcome(status), { code: 0, stdout: `Key in use: the key file ${file}\nKey file: ${file} (saved)\n`, stderr: "" });
  assert.deepEqual(outcome(removed), { code: 0, stdout: `Removed the key file ${file}.\n`, stderr: "" });
  assert.deepEqual(outcome(afterRemove), { code: 3, stdout: "", stderr: NO_CREDENTIAL });
  assert.deepEqual(outcome(statusAfter), { code: 3, stdout: `Key in use: none\nKey file: ${file} (not saved)\n`, stderr: "" });
  assert.deepEqual(outcome(removedAgain), { code: 0, stdout: `No key file at ${file}.\n`, stderr: "" });
  assert.equal(api.requests.length, 1);
});

test("the saved file has mode 0600 in a folder with mode 0700, and XDG_CONFIG_HOME moves it", async (t) => {
  const { home, file, cli } = await setUp(t);
  const xdg = tempDir(t);

  await cli(["auth", "save"], { input: KEY });
  const underXdg = await runCli(["auth", "save"], { home, xdg, input: KEY });

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".config", "enrichlayer-v3")).mode & 0o777, 0o700);
  assert.equal(underXdg.stdout, `Saved the API key to ${join(xdg, "enrichlayer-v3", "credentials.json")}.\n`);
  assert.equal(statSync(join(xdg, "enrichlayer-v3", "credentials.json")).mode & 0o777, 0o600);
});

test("with ENRICHLAYER_API_KEY set the variable wins, and the auth commands say so; an empty variable counts as unset", async (t) => {
  const { api, file, cli } = await setUp(t);
  const env = { ENRICHLAYER_API_KEY: "env-key" };

  const saved = await cli(["auth", "save"], { input: KEY, env });
  const status = await cli(["auth", "status"], { env });
  const call = await cli(["company-search", "--q", "acme"], { env });
  const emptyVariable = await cli(["company-search", "--q", "acme"], { env: { ENRICHLAYER_API_KEY: "" } });
  const removed = await cli(["auth", "remove"], { env });

  assert.deepEqual(outcome(saved), {
    code: 0,
    stdout: `Saved the API key to ${file}.\nENRICHLAYER_API_KEY is set and takes precedence over the key file.\n`,
    stderr: "",
  });
  assert.deepEqual(outcome(status), { code: 0, stdout: `Key in use: ENRICHLAYER_API_KEY\nKey file: ${file} (saved)\n`, stderr: "" });
  assert.equal(call.code, 0);
  assert.equal(emptyVariable.code, 0);
  assert.deepEqual(api.requests.map((request) => request.headers.authorization), ["Bearer env-key", `Bearer ${KEY}`]);
  assert.deepEqual(outcome(removed), {
    code: 0,
    stdout: `Removed the key file ${file}.\nENRICHLAYER_API_KEY is still set and stays in use.\n`,
    stderr: "",
  });
});

test("auth save refuses an empty stdin and a key a key cannot be; auth alone shows its help", async (t) => {
  const { cli } = await setUp(t);

  const empty = await cli(["auth", "save"], { input: "\n" });
  const nothing = await cli(["auth", "save"]);
  const twoWords = await cli(["auth", "save"], { input: "sk-one sk-two\n" });
  const bare = await cli(["auth"]);
  const help = await cli(["auth", "--help"]);

  const noKeyOnStdin = "error: No key on stdin. Pipe it in, for example: enrichlayer-v3 auth save < key.txt\n";
  assert.deepEqual(outcome(empty), { code: 2, stdout: "", stderr: noKeyOnStdin });
  assert.deepEqual(outcome(nothing), { code: 2, stdout: "", stderr: noKeyOnStdin });
  assert.deepEqual(outcome(twoWords), {
    code: 3,
    stdout: "",
    stderr:
      "error: The key from stdin contains a space, a line break or another character an API key cannot have. Copy the key again from https://enrichlayer.com/dashboard.\n",
  });
  assert.deepEqual([bare.code, bare.stdout, bare.stderr], [2, "", help.stdout]);
  assert.equal(help.code, 0);
});

test("--dry-run names the key file, and a key the API rejects names it too", async (t) => {
  const { file, cli } = await setUp(t, () => ({ status: 401, body: { description: "Invalid API key" }, headers: headers(0, "req-401") }));
  await cli(["auth", "save"], { input: KEY });

  const dryRun = await cli(["company-search", "--q", "acme", "--dry-run"]);
  const rejected = await cli(["company-search", "--q", "acme"]);

  assert.equal(JSON.parse(dryRun.stdout).headers.Authorization, `Bearer <the key file ${file}>`);
  assert.deepEqual(outcome(rejected), {
    code: 3,
    stdout: "",
    stderr: `error: The API key from the key file ${file} was rejected: Invalid API key. Use a valid key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-401)\n`,
  });
});

test("a key file readable by others, a broken one and a folder in its place stop the call with exit code 3", async (t) => {
  const { api, file, cli } = await setUp(t);
  await cli(["auth", "save"], { input: KEY });

  chmodSync(file, 0o644);
  const open = await cli(["company-search", "--q", "acme"]);
  const openStatus = await cli(["auth", "status"]);
  writeFileSync(file, `{"apiKey":"${KEY}`);
  chmodSync(file, 0o600);
  const broken = await cli(["company-search", "--q", "acme"]);
  const brokenStatus = await cli(["auth", "status"]);

  assert.deepEqual(outcome(open), {
    code: 3,
    stdout: "",
    stderr: `error: The key file ${file} can be read by other users (mode 0644). Run chmod 600 ${file}, or save the key again with enrichlayer-v3 auth save.\n`,
  });
  assert.deepEqual(outcome(openStatus), {
    code: 3,
    stdout: `Key in use: none\nKey file: ${file} (not usable: readable by other users, mode 0644)\n`,
    stderr: "",
  });
  assert.deepEqual(outcome(broken), {
    code: 3,
    stdout: "",
    stderr: `error: The key file ${file} is not valid. Save the key again with enrichlayer-v3 auth save, or remove it with enrichlayer-v3 auth remove.\n`,
  });
  assert.equal(brokenStatus.stdout, `Key in use: none\nKey file: ${file} (not usable: not valid)\n`);
  assert.equal(api.requests.length, 0);
});

test("the key never shows in the output of any command, errors included", async (t) => {
  const replies = [
    { status: 401, body: { description: "Invalid API key" } },
    { status: 404, body: { description: "Not found" } },
    { body: [{ companyName: "Acme" }] },
  ];
  const { file, cli } = await setUp(t, (_request, count) => replies[(count - 1) % replies.length]);

  const outputs = [];
  const run = async (args, options) => outputs.push(await cli(args, options));
  await run(["auth", "save"], { input: KEY });
  await run(["auth", "status"]);
  await run(["company-search", "--q", "acme", "--dry-run"]);
  await run(["company-search", "--q", "acme"]);
  await run(["person", "--profile", "jane"]);
  await run(["company-search", "--q", "acme", "--format", "table"]);
  await run(["company-search", "--q", "acme", "--api-kei=" + KEY]);
  await run(["company-search", "--q", "acme", "--api-key", `${KEY} x`]);
  await run(["company-search", "--q", "acme", "--dry-run"], { env: { ENRICHLAYER_API_KEY: KEY } });
  await run(["auth", "save"], { input: `${KEY} ${KEY}` });
  chmodSync(file, 0o644);
  await run(["company-search", "--q", "acme"]);
  await run(["auth", "status"]);
  writeFileSync(file, `{"apiKey":"${KEY}`);
  chmodSync(file, 0o600);
  await run(["company-search", "--q", "acme"]);
  await run(["auth", "remove"]);

  for (const { stdout, stderr } of outputs) assert.equal(`${stdout}${stderr}`.includes(KEY), false, `${stdout}${stderr}`);
  assert.equal(outputs.length, 14);
});
