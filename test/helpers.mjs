import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiKeyCredentials } from "../build/auth/api-key.js";
import { createV3Client } from "../build/client.js";
import { USER_AGENT } from "../build/config.js";

const home = mkdtempSync(join(tmpdir(), "enrichlayer-cli-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
for (const name of Object.keys(process.env)) if (name.startsWith("ENRICHLAYER_")) delete process.env[name];
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

export async function startApi(respond) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers };
    requests.push(request);
    const reply = await respond(request, requests.length);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    if (reply.dropAfterBody) res.write(body, () => res.socket.destroy());
    else res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function testClient(baseUrl, overrides = {}) {
  return createV3Client({
    baseUrl,
    userAgent: USER_AGENT,
    credentials: apiKeyCredentials({ env: { ENRICHLAYER_API_KEY: "test-key" } }),
    timeoutMs: 2_000,
    retryDelaysMs: [0, 0],
    ...overrides,
  });
}

export const headers = (creditCost, requestId) => ({ "X-EnrichLayer-Credit-Cost": String(creditCost), "X-Request-Id": requestId });

const CLI_PATH = fileURLToPath(new URL("../build/cli.js", import.meta.url));

export function startCli(args, { env = {} } = {}) {
  const cliHome = mkdtempSync(join(tmpdir(), "enrichlayer-cli-home-"));
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    env: { PATH: process.env.PATH, HOME: cliHome, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) =>
    child.on("close", (code) => {
      const homeEntries = readdirSync(cliHome);
      rmSync(cliHome, { recursive: true, force: true });
      resolve({ code, stdout, stderr, homeEntries });
    }),
  );
  return { child, done };
}

export const runCli = (args, options) => startCli(args, options).done;
