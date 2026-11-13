#!/usr/bin/env node
import { CommanderError } from "commander";
import { apiKeyCredentials } from "./auth/api-key.js";
import { createV3Client, requestUrl } from "./client.js";
import { apiBaseUrl, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, USER_AGENT } from "./config.js";
import { cutOffAdvice, describeFailure, EXIT_CODES } from "./errors.js";
import { v3Params } from "./generated/v3-params.js";
import { buildProgram, type CommandRun, splitAssignments } from "./program.js";

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

async function run({ def, params, apiKey, dryRun }: CommandRun): Promise<void> {
  const problem = def.checkParams?.(params);
  if (problem) return fail(problem, EXIT_CODES.usage);

  const credentials = apiKeyCredentials({ flag: apiKey });
  const hasMaxAgeSeconds = v3Params[def.path].some((param) => param.name === "maxAgeSeconds");
  const context = { keySource: credentials.source, hasMaxAgeSeconds };
  const baseUrl = apiBaseUrl();

  if (dryRun) {
    try {
      credentials.authorization();
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
    printJson(result);
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

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit();
    throw error;
  });
}

try {
  await buildProgram(run).parseAsync(splitAssignments(process.argv.slice(2)), { from: "user" });
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? EXIT_CODES.ok : EXIT_CODES.usage;
  else fail(error instanceof Error ? error.message : String(error), EXIT_CODES.unexpected);
}
