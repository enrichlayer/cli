#!/usr/bin/env node
import { CommanderError } from "commander";
import { type Credentials, DASHBOARD_URL, isKeyInEnv, isValidKey, SIGN_IN_SOURCE } from "./auth/api-key.js";
import { errorCode, keyFilePath, readKeyFile, removeKeyFile, saveKeyFile } from "./auth/key-file.js";
import { defaultStore, resolveCredentials, SignInCredentials, sessionDir } from "./auth/sign-in.js";
import { createV3Client, requestUrl } from "./client.js";
import { apiBaseUrl, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, USER_AGENT } from "./config.js";
import { cutOffAdvice, describeFailure, EXIT_CODES } from "./errors.js";
import { v3Params } from "./generated/v3-params.js";
import { applyInstall, describePlan, MCP_CLIENTS, planInstall } from "./mcp-install.js";
import { render } from "./output.js";
import { type AuthAction, type AuthOptions, buildProgram, type CommandRun, type McpInstallRun, splitAssignments } from "./program.js";
import { login, logout, type SignInDeps, signInStatus } from "./sign-in-commands.js";

const FIELDS_FORMATS = ["table", "csv"];

const INDICATOR_DELAY_MS = 2_000;

function printJson(value: unknown): void {
  process.stdout.write(`${process.stdout.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);
}

function fail(message: string, exitCode: number): void {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = exitCode;
}

function secondsSince(started: number): number {
  return Math.floor((performance.now() - started) / 1000);
}

function startIndicator(started: number): () => void {
  if (!process.stderr.isTTY) return () => {};
  const show = () => process.stderr.write(`\r\x1b[2KWaiting for Enrich Layer: ${secondsSince(started)} s. Ctrl-C stops waiting.`);
  let interval: NodeJS.Timeout | undefined;
  const delay = setTimeout(() => {
    show();
    interval = setInterval(show, 1_000);
  }, INDICATOR_DELAY_MS);
  return () => {
    clearTimeout(delay);
    clearInterval(interval);
    if (interval) process.stderr.write("\r\x1b[2K");
  };
}

async function run({ def, params, apiKey, dryRun, format, fields }: CommandRun): Promise<void> {
  const problem = def.checkParams?.(params);
  if (problem) return fail(problem, EXIT_CODES.usage);
  if (fields && !FIELDS_FORMATS.includes(format))
    return fail("--fields works with --format table or csv; json, yaml and jsonl print the whole answer.", EXIT_CODES.usage);

  const hasMaxAgeSeconds = v3Params[def.path].some((param) => param.name === "maxAgeSeconds");
  let credentials: Credentials;
  try {
    credentials = await resolveCredentials({ flag: apiKey });
  } catch (error) {
    const failure = describeFailure(error, { keySource: SIGN_IN_SOURCE, hasMaxAgeSeconds });
    return fail(failure.message, failure.exitCode);
  }
  const context = { keySource: credentials.source, hasMaxAgeSeconds };
  const baseUrl = apiBaseUrl();

  if (dryRun) {
    try {
      // A dry run must not refresh: a refresh rotates the refresh token. Check the stored pair as it is.
      if (credentials instanceof SignInCredentials) await credentials.tokens();
      else await credentials.authorization();
    } catch (error) {
      const failure = describeFailure(error, context);
      return fail(failure.message, failure.exitCode);
    }
    return printJson({
      dryRun: true,
      method: "GET",
      url: requestUrl(baseUrl, def.path, params),
      headers: { Authorization: `Bearer <${credentials.source}>`, Accept: "application/json", "User-Agent": USER_AGENT },
    });
  }

  const callV3 = createV3Client({ baseUrl, userAgent: USER_AGENT, credentials, timeoutMs: REQUEST_TIMEOUT_MS, retryDelaysMs: RETRY_DELAYS_MS });
  const controller = new AbortController();
  const stop = () => controller.abort();
  const started = performance.now();
  process.once("SIGINT", stop);
  const stopIndicator = startIndicator(started);
  try {
    const result = await callV3({ path: def.path, params, signal: controller.signal });
    stopIndicator();
    const rendered = render({ result, format, fields, rowsPath: def.rows, isTerminal: process.stdout.isTTY === true });
    process.stdout.write(rendered.stdout);
    for (const note of rendered.notes) process.stderr.write(`${note}\n`);
  } catch (error) {
    stopIndicator();
    if (controller.signal.aborted)
      return fail(`Stopped waiting after ${secondsSince(started)} s. ${cutOffAdvice(hasMaxAgeSeconds)}`, EXIT_CODES.stopped);
    const failure = describeFailure(error, context);
    fail(failure.message, failure.exitCode);
  } finally {
    process.off("SIGINT", stop);
  }
}

const PIPE_EXAMPLE = "enrichlayer-v3 auth save < key.txt";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function saveKey(file: string): Promise<void> {
  if (process.stdin.isTTY) return fail(`auth save reads the key from stdin, not from the keyboard. Pipe it in, for example: ${PIPE_EXAMPLE}`, EXIT_CODES.usage);
  const key = (await readStdin()).trim();
  if (!key) return fail(`No key on stdin. Pipe it in, for example: ${PIPE_EXAMPLE}`, EXIT_CODES.usage);
  if (!isValidKey(key))
    return fail(
      `The key from stdin contains a space, a line break or another character an API key cannot have. Copy the key again from ${DASHBOARD_URL}.`,
      EXIT_CODES.key,
    );
  try {
    saveKeyFile(file, key);
  } catch (error) {
    return fail(`Could not save the key to ${file} (${errorCode(error)}).`, EXIT_CODES.unexpected);
  }
  say(`Saved the API key to ${file}.`);
  if (isKeyInEnv()) say("ENRICHLAYER_API_KEY is set and takes precedence over the key file.");
}

async function showStatus(file: string, deps: SignInDeps): Promise<void> {
  const state = readKeyFile(file);
  const inUse = isKeyInEnv() ? "ENRICHLAYER_API_KEY" : state.status === "saved" ? `the key file ${file}` : "none";
  const fileState = state.status === "saved" ? "saved" : state.status === "missing" ? "not saved" : `not usable: ${state.reason}`;
  say(`Key in use: ${inUse}`);
  say(`Key file: ${file} (${fileState})`);
  const signedIn = await signInStatus(deps);
  if (inUse === "none" && !signedIn) process.exitCode = EXIT_CODES.key;
}

/** The key that takes precedence over a sign-in: the variable, or a key file, usable or not. */
function keyInUse(file: string): string | null {
  if (isKeyInEnv()) return "ENRICHLAYER_API_KEY";
  return readKeyFile(file).status === "missing" ? null : `the key file ${file}`;
}

async function signIn(action: (deps: SignInDeps) => Promise<void>, file: string): Promise<void> {
  const deps: SignInDeps = {
    env: process.env,
    store: defaultStore(),
    lockDir: sessionDir(),
    say,
    note: (line) => process.stderr.write(`${line}\n`),
    keyInUse: () => keyInUse(file),
  };
  try {
    await action(deps);
  } catch (error) {
    const failure = describeFailure(error, { keySource: SIGN_IN_SOURCE, hasMaxAgeSeconds: false });
    fail(failure.message, failure.exitCode);
  }
}

function removeKey(file: string): void {
  try {
    say(removeKeyFile(file) ? `Removed the key file ${file}.` : `No key file at ${file}.`);
  } catch (error) {
    return fail(`Could not remove ${file} (${errorCode(error)}).`, EXIT_CODES.unexpected);
  }
  if (isKeyInEnv()) say("ENRICHLAYER_API_KEY is still set and stays in use.");
}

async function auth(action: AuthAction, options: AuthOptions = {}): Promise<void> {
  const file = keyFilePath();
  if (action === "save") return saveKey(file);
  if (action === "status") return signIn((deps) => showStatus(file, deps), file);
  if (action === "login") return signIn((deps) => login(options.noBrowser === true, deps), file);
  if (action === "logout") return signIn(logout, file);
  return removeKey(file);
}

function mcpInstall({ client, dryRun, force }: McpInstallRun): void {
  if (client === undefined) return say(`Clients: ${MCP_CLIENTS.join(", ")}. Run enrichlayer-v3 mcp install <client>.`);
  const plan = planInstall({ client, force });
  if (dryRun && plan.action !== "refuse") return printJson({ dryRun: true, client, ...describePlan(plan) });
  const { lines, error } = applyInstall(plan);
  for (const line of lines) say(line);
  if (error) fail(error, EXIT_CODES.unexpected);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit();
    throw error;
  });
}

try {
  await buildProgram({ run, auth, mcpInstall }).parseAsync(splitAssignments(process.argv.slice(2)), { from: "user" });
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? EXIT_CODES.ok : EXIT_CODES.usage;
  else fail(error instanceof Error ? error.message : String(error), EXIT_CODES.unexpected);
}
