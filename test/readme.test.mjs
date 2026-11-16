import { headers, startApi, tempDir } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const CLI_PATH = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const NOT_RUN = /^(npm|npx|export|git|cd|node)\b/;

const ANSWERS = {
  "/v3/person": { fullName: "Jane Example", headline: "CTO", location: { city: "Austin" }, experience: { work: [{ title: "CTO" }] } },
  "/v3/company": { name: "Acme", funding: { rounds: [] } },
  "/v3/company/search": [{ companyName: "Acme", domain: { resolved: "acme.com" } }],
  "/v3/company/logo": [{ companyName: "Acme", logoUrl: "https://example.com/acme.png" }],
  "/v3/email/prospect": { name: "Satya Nadella", emails: [{ email: "satya@example.com", validity: "valid" }] },
  "/v3/email/validate": { email: "jane@example.com", emailStatus: "valid" },
};

function examples(markdown) {
  return [...markdown.matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .flatMap(([, block]) => block.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !NOT_RUN.test(line) && /(^|\|\s*)enrichlayer-v3\b/.test(line));
}

function shell(line, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", line], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("the README has the examples this test runs", () => {
  assert.equal(examples(README).length, 14);
});

test("every enrichlayer-v3 example in the README runs and exits with 0", async (t) => {
  const api = await startApi((request) => ({ body: ANSWERS[request.path] ?? {}, headers: headers(1, "req-readme") }));
  t.after(api.close);
  const home = tempDir(t);
  const bin = join(home, "bin");
  const work = join(home, "work");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, "enrichlayer-v3"), `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`);
  chmodSync(join(bin, "enrichlayer-v3"), 0o755);
  writeFileSync(join(work, "key.txt"), "sk-readme-test\n");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    ENRICHLAYER_API_KEY: "sk-readme-test",
    ENRICHLAYER_API_BASE_URL: api.url,
    ENRICHLAYER_CREDENTIAL_STORE: "file",
  };

  for (const line of examples(README)) {
    await t.test(line, async () => {
      const { code, output } = await shell(line, { cwd: work, env });
      assert.equal(code, 0, output);
    });
  }
});
