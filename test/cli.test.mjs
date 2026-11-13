import { headers, runCli, startApi, startCli } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const PERSON = { fullName: "Jane Example", experience: { work: [] } };
const SAVED_COPY =
  "The call may still be charged. To get the copy that was saved in the meantime, run the same command without --max-age-seconds; do not repeat a live lookup right away.";
const NO_KEY = "error: No API key. Set ENRICHLAYER_API_KEY or pass --api-key; create a key at https://enrichlayer.com/dashboard.\n";

async function withApi(t, respond = () => ({ body: PERSON, headers: headers(1, "req-1") })) {
  const api = await startApi(respond);
  t.after(api.close);
  return { api, env: { ENRICHLAYER_API_KEY: "test-key", ENRICHLAYER_API_BASE_URL: api.url } };
}

test("prints the answer, the credit cost and the request id as one line of JSON", async (t) => {
  const { env } = await withApi(t);

  const result = await runCli(["person", "--profile", "jane"], { env });

  assert.deepEqual(result, {
    code: 0,
    stdout: `${JSON.stringify({ data: PERSON, creditCost: 1, requestId: "req-1" })}\n`,
    stderr: "",
    homeEntries: [],
  });
});

test("an API error goes to stderr as one line with its exit code, and stdout stays empty", async (t) => {
  const cases = [
    {
      reply: { status: 400, body: { description: "Invalid LinkedIn URL." }, headers: headers(0, "req-400") },
      code: 2,
      stderr: "error: The request was rejected as invalid: Invalid LinkedIn URL. Fix the flags and run again. (credits charged: 0, request id: req-400)\n",
    },
    {
      reply: { status: 401, body: { description: "Invalid API key" }, headers: headers(0, "req-401") },
      code: 3,
      stderr:
        "error: The API key from ENRICHLAYER_API_KEY was rejected: Invalid API key. Use a valid key from https://enrichlayer.com/dashboard. (credits charged: 0, request id: req-401)\n",
    },
    {
      reply: { status: 404, body: { description: "Person not found" }, headers: headers(0, "req-404") },
      code: 4,
      stderr:
        "error: Not found: Person not found. Check the identifier (URL, username, email or domain), or look it up by another identifier. (credits charged: 0, request id: req-404)\n",
    },
    {
      reply: { status: 503, body: { description: "Billing service unavailable" }, headers: { ...headers(0, "req-503"), "Retry-After": "0" } },
      code: 5,
      stderr: "error: Enrich Layer is unavailable right now (503): Billing service unavailable. Try again in a few minutes. (credits charged: 0, request id: req-503)\n",
    },
    {
      reply: { body: '{"fullName":"Ja', dropAfterBody: true, headers: headers(10, "req-cut") },
      code: 6,
      stderr: `error: The connection broke while the answer was arriving (HTTP 200). ${SAVED_COPY} (credits charged: 10, request id: req-cut)\n`,
    },
    {
      reply: { status: 418, body: { description: "I'm a teapot" }, headers: headers(0, "req-418") },
      code: 1,
      stderr:
        "error: Enrich Layer API error 418: I'm a teapot. Try again later; if it keeps failing, contact support@enrichlayer.com with the request id. (credits charged: 0, request id: req-418)\n",
    },
  ];

  for (const { reply, code, stderr } of cases) {
    const { env } = await withApi(t, () => reply);

    const result = await runCli(["person", "--profile", "jane"], { env });

    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code, stdout: "", stderr });
  }
});

test("an unreachable host exits with 5", async () => {
  const closed = await startApi(() => ({ body: {} }));
  await closed.close();

  const result = await runCli(["company-search", "--q", "acme"], { env: { ENRICHLAYER_API_KEY: "test-key", ENRICHLAYER_API_BASE_URL: closed.url } });

  assert.equal(result.code, 5);
  assert.equal(
    result.stderr,
    `error: Could not reach Enrich Layer at ${closed.url}: connect ECONNREFUSED ${new URL(closed.url).host}. Check the network connection and ENRICHLAYER_API_BASE_URL, then run again.\n`,
  );
});

test("a person without an identifier or with two is refused before any request", async (t) => {
  const { api, env } = await withApi(t);

  const none = await runCli(["person", "--work-email"], { env });
  const two = await runCli(["person", "--profile", "jane", "--email", "jane@acme.com"], { env });

  assert.deepEqual([none.code, none.stderr], [2, "error: Pass exactly one of --profile, --email, --twitter, --facebook, --github.\n"]);
  assert.deepEqual(
    [two.code, two.stderr],
    [2, "error: Pass exactly one of --profile, --email, --twitter, --facebook, --github — got --profile, --email.\n"],
  );
  assert.equal(api.requests.length, 0);
});

test("a work email search without a domain is refused before any request", async (t) => {
  const { api, env } = await withApi(t);

  const result = await runCli(["email-prospect", "--full-name", "Jane Doe"], { env });

  assert.deepEqual([result.code, result.stderr], [2, "error: Pass --full-name, or --first-name and/or --last-name, together with --domain.\n"]);
  assert.equal(api.requests.length, 0);
});

test("wrong flags and values exit with 2 before any request", async (t) => {
  const { api, env } = await withApi(t);
  const cases = [
    [["person", "--profile", "jane", "--bogus"], "error: unknown option '--bogus'\n"],
    [["company"], "error: required option '--url <value>' not specified\n"],
    [
      ["email-prospect", "--full-name", "Jane Doe", "--domain", "acme.com", "--limit", "11"],
      "error: option '--limit <value>' argument '11' is invalid. Expected a whole number from 1 to 10.\n",
    ],
    [["person", "--profile", "jane", "--max-age-seconds", "-1"], "error: option '--max-age-seconds <value>' argument '-1' is invalid. Expected a whole number of 0 or more.\n"],
    [["person", "--profile", "jane", "--max-age-seconds", "1.5"], "error: option '--max-age-seconds <value>' argument '1.5' is invalid. Expected a whole number of 0 or more.\n"],
  ];

  for (const [args, stderr] of cases) {
    const result = await runCli(args, { env });

    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 2, stdout: "", stderr }, args.join(" "));
  }
  assert.equal(api.requests.length, 0);
});

test("a mistyped flag written with = does not print its value", async (t) => {
  const { api, env } = await withApi(t);

  const typo = await runCli(["person", "--profile", "jane", "--api-kei=SECRET-123"], { env });
  const switchWithValue = await runCli(["person", "--profile", "jane", "--work-email=SECRET-123"], { env });

  assert.deepEqual([typo.code, typo.stdout, typo.stderr], [2, "", "error: unknown option '--api-kei'\n(Did you mean --api-key?)\n"]);
  assert.deepEqual(
    [switchWithValue.code, switchWithValue.stdout, switchWithValue.stderr],
    [2, "", "error: too many arguments for 'person'. Expected 0 arguments but got 1.\n"],
  );
  assert.equal(api.requests.length, 0);
});

test("a key from --api-key wins over ENRICHLAYER_API_KEY, also written with =", async (t) => {
  const { api, env } = await withApi(t);

  const result = await runCli(["person", "--profile", "jane", "--api-key=flag-key"], { env });

  assert.equal(result.code, 0);
  assert.equal(api.requests[0].headers.authorization, "Bearer flag-key");
});

test("--dry-run prints the request the call would send, sends nothing and hides the key", async (t) => {
  const { api, env } = await withApi(t);
  const args = ["person", "--profile", "https://www.linkedin.com/in/jane/", "--work-email"];

  const dryRun = await runCli([...args, "--dry-run"], { env });
  const withFlagKey = await runCli([...args, "--dry-run", "--api-key", "flag-secret"], { env });
  assert.equal(api.requests.length, 0);
  await runCli(args, { env });

  const printed = JSON.parse(dryRun.stdout);
  assert.deepEqual(printed, {
    dryRun: true,
    method: "GET",
    url: `${api.url}/v3/person?profile=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjane%2F&workEmail=include`,
    headers: { Authorization: "Bearer <ENRICHLAYER_API_KEY>", Accept: "application/json", "User-Agent": "enrichlayer-cli-v3/0.1.0" },
  });
  assert.equal(dryRun.code, 0);
  assert.equal(dryRun.stderr, "");
  assert.equal(JSON.parse(withFlagKey.stdout).headers.Authorization, "Bearer <--api-key>");
  assert.equal(withFlagKey.stdout.includes("flag-secret"), false);
  const sent = new URL(printed.url);
  assert.equal(api.requests[0].path, sent.pathname);
  assert.deepEqual(api.requests[0].query, Object.fromEntries(sent.searchParams));
});

test("--dry-run checks the key like a real call", async () => {
  const result = await runCli(["company-search", "--q", "acme", "--dry-run"]);

  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, { code: 3, stdout: "", stderr: NO_KEY });
});

test("Ctrl-C stops waiting, exits with 130 and warns that the call may be charged", async (t) => {
  let arrived;
  const arrival = new Promise((resolve) => (arrived = resolve));
  const { env } = await withApi(t, () => {
    arrived();
    return { delayMs: 3_000, body: PERSON };
  });

  const cli = startCli(["person", "--profile", "jane", "--max-age-seconds", "0"], { env });
  await arrival;
  cli.child.kill("SIGINT");
  const result = await cli.done;

  assert.equal(result.code, 130);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.replace(/after \d+ s/, "after N s"), `error: Stopped waiting after N s. ${SAVED_COPY}\n`);
});

test("a reader that closes stdout after the first bytes gets a quiet exit with 0", async (t) => {
  const { env } = await withApi(t, () => ({ body: { text: "x".repeat(1_000_000) }, headers: headers(1, "req-big") }));

  const cli = startCli(["company", "--url", "https://www.linkedin.com/company/acme"], { env });
  cli.child.stdout.once("data", () => cli.child.stdout.destroy());
  const result = await cli.done;

  assert.deepEqual([result.code, result.stderr], [0, ""]);
});

test("a reader that closes stderr gets a quiet exit that keeps the code of the error", async (t) => {
  const { env } = await withApi(t, () => ({ status: 404, body: { description: "Person not found" }, headers: headers(0, "req-404") }));

  const cli = startCli(["person", "--profile", "nobody"], { env });
  cli.child.stderr.destroy();
  const result = await cli.done;

  assert.deepEqual([result.code, result.stdout], [4, ""]);
});

test("--help and --version exit with 0; no command shows the help and exits with 2", async () => {
  const help = await runCli(["--help"]);
  const version = await runCli(["--version"]);
  const none = await runCli([]);

  assert.deepEqual([help.code, help.stderr], [0, ""]);
  assert.deepEqual([version.code, version.stdout], [0, "0.1.0\n"]);
  assert.deepEqual([none.code, none.stdout, none.stderr], [2, "", help.stdout]);
});
