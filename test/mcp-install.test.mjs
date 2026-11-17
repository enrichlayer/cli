import { runCli, tempDir } from "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL = "https://mcp.enrichlayer.com/v3/mcp";
const ENTRY = '"enrichlayer-v3": {"url":"https://mcp.enrichlayer.com/v3/mcp"}';
const VSCODE_JSON = '{"name":"enrichlayer-v3","type":"http","url":"https://mcp.enrichlayer.com/v3/mcp"}';
const modeOf = (path) => statSync(path).mode & 0o777;

function fakeClients(t, programs, { exitCode = 0 } = {}) {
  const bin = tempDir(t);
  const log = join(bin, "calls.log");
  for (const program of programs) {
    writeFileSync(join(bin, program), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done\necho "${program} ran"\nexit ${exitCode}\n`);
    chmodSync(join(bin, program), 0o755);
  }
  return { env: { PATH: bin, ENRICHLAYER_API_KEY: "sk-canary" }, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []) };
}

function cursorHome(t, content, { mode = 0o644 } = {}) {
  const home = realpathSync(tempDir(t));
  const folder = join(home, ".cursor");
  const file = join(folder, "mcp.json");
  mkdirSync(folder);
  if (content !== undefined) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return { home, folder, file, env: { PATH: tempDir(t), ENRICHLAYER_API_KEY: "sk-canary" } };
}

test("each client with its own command is asked to add the hosted server", async (t) => {
  const cases = [
    {
      client: "claude-code",
      program: "claude",
      args: ["mcp", "add", "--scope", "user", "--transport", "http", "enrichlayer-v3", URL],
      lines: `Added enrichlayer-v3 (${URL}) to Claude Code.\nTo sign in, run /mcp in Claude Code or claude mcp login enrichlayer-v3.\n`,
    },
    {
      client: "codex",
      program: "codex",
      args: ["mcp", "add", "enrichlayer-v3", "--url", URL],
      lines: `Added enrichlayer-v3 (${URL}) to Codex.\nTo sign in, run codex mcp login enrichlayer-v3. Codex stops a tool call after 60 seconds by default; for live lookups set tool_timeout_sec = 310 under [mcp_servers.enrichlayer-v3] in ~/.codex/config.toml.\n`,
    },
    {
      client: "vscode",
      program: "code",
      args: ["--add-mcp", VSCODE_JSON],
      lines: `Added enrichlayer-v3 (${URL}) to VS Code.\nVS Code opens the Enrich Layer sign-in page when the server first starts.\n`,
    },
  ];

  for (const { client, program, args, lines } of cases) {
    await t.test(client, async (t) => {
      const { env, calls } = fakeClients(t, ["claude", "codex", "code"]);

      const result = await runCli(["mcp", "install", client], { env });

      assert.deepEqual(result, { code: 0, stdout: `${program} ran\n${lines}`, stderr: "", homeEntries: [] });
      assert.deepEqual(calls(), args);
    });
  }
});

test("a client command that is not installed stops with the command to run by hand", async (t) => {
  const { env, calls } = fakeClients(t, []);

  const result = await runCli(["mcp", "install", "vscode"], { env });

  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: `error: The code command of VS Code was not found. Install VS Code, or run this where it is installed: code --add-mcp '${VSCODE_JSON}'\n`,
    homeEntries: [],
  });
  assert.deepEqual(calls(), []);
});

test("a client that refuses to add the server ends the command with 1", async (t) => {
  const { env } = fakeClients(t, ["claude"], { exitCode: 3 });

  const result = await runCli(["mcp", "install", "claude-code"], { env });

  assert.deepEqual(result, {
    code: 1,
    stdout: "claude ran\n",
    stderr: `error: Claude Code did not add the server: claude exited with 3. The command was: claude mcp add --scope user --transport http enrichlayer-v3 ${URL}\n`,
    homeEntries: [],
  });
});

test("--dry-run prints the client command and does not run it", async (t) => {
  const { env, calls } = fakeClients(t, ["claude", "codex", "code"]);

  const result = await runCli(["mcp", "install", "codex", "--dry-run"], { env });

  assert.deepEqual(result, {
    code: 0,
    stdout: `${JSON.stringify({ dryRun: true, client: "codex", run: `codex mcp add enrichlayer-v3 --url ${URL}` })}\n`,
    stderr: "",
    homeEntries: [],
  });
  assert.deepEqual(calls(), []);
});

test("Cursor without its folder is reported as not found and nothing is created", async (t) => {
  const home = tempDir(t);

  const result = await runCli(["mcp", "install", "cursor"], { home, env: { PATH: tempDir(t) } });

  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: `error: Cursor was not found: there is no folder ${join(home, ".cursor")}. Install Cursor and open it once, then run again.\n`,
    homeEntries: [],
  });
});

test("Cursor without mcp.json gets a private file with the one entry", async (t) => {
  const { home, folder, file, env } = cursorHome(t);

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(result, {
    code: 0,
    stdout: `Added enrichlayer-v3 in ${file}.\nCursor opens the Enrich Layer sign-in page when it connects to the server.\nTo remove the server, delete the enrichlayer-v3 entry from that file.\n`,
    stderr: "",
    homeEntries: [".cursor"],
  });
  assert.equal(readFileSync(file, "utf8"), `{\n  "mcpServers": {\n    "enrichlayer-v3": {\n      "url": "${URL}"\n    }\n  }\n}\n`);
  assert.equal(modeOf(file), 0o600);
  assert.deepEqual(readdirSync(folder), ["mcp.json"]);
});

test("an empty mcp.json is filled in", async (t) => {
  const { home, file, env } = cursorHome(t, "\n");

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { "enrichlayer-v3": { url: URL } } });
});

test("the entry is added beside the other servers and settings, with the file's indent and mode", async (t) => {
  const before = {
    theme: "dark",
    mcpServers: { other: { command: "npx", args: ["-y", "other-server"], env: { OTHER_KEY: "other-secret" } } },
  };
  const { home, folder, file, env } = cursorHome(t, JSON.stringify(before, null, 4), { mode: 0o640 });

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.equal(result.code, 0);
  assert.equal(
    readFileSync(file, "utf8"),
    `${JSON.stringify({ theme: "dark", mcpServers: { ...before.mcpServers, "enrichlayer-v3": { url: URL } } }, null, 4)}\n`,
  );
  assert.equal(modeOf(file), 0o640);
  assert.deepEqual(readdirSync(folder), ["mcp.json"]);
});

test("a second run finds the entry and leaves the file untouched", async (t) => {
  const content = `{"mcpServers":{"enrichlayer-v3":{"url":"${URL}"},   "other":{"command":"x"}}}`;
  const { home, file, env } = cursorHome(t, content);

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(result, { code: 0, stdout: `enrichlayer-v3 is already in ${file}.\n`, stderr: "", homeEntries: [".cursor"] });
  assert.equal(readFileSync(file, "utf8"), content);
});

test("a different enrichlayer-v3 entry is kept unless --force is given", async (t) => {
  const content = '{\n  "mcpServers": {\n    "enrichlayer-v3": {\n      "command": "npx"\n    }\n  }\n}\n';
  const { home, file, env } = cursorHome(t, content);

  const refused = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(refused, {
    code: 1,
    stdout: "",
    stderr: `error: ${file} already has a different enrichlayer-v3 entry. Run again with --force to replace it with ${ENTRY}\n`,
    homeEntries: [".cursor"],
  });
  assert.equal(readFileSync(file, "utf8"), content);

  const forced = await runCli(["mcp", "install", "cursor", "--force"], { home, env });

  assert.equal(forced.code, 0);
  assert.equal(forced.stdout.split("\n")[0], `Replaced enrichlayer-v3 in ${file}.`);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { "enrichlayer-v3": { url: URL } } });
});

test("a file that cannot be merged safely is left as it is", async (t) => {
  const cases = [
    { content: '{\n  // my servers\n  "mcpServers": {}\n}\n', problem: "is not valid JSON" },
    { content: "[]\n", problem: "does not hold a JSON object" },
    { content: '{"mcpServers":[]}\n', problem: null },
  ];

  for (const { content, problem } of cases) {
    await t.test(content, async (t) => {
      const { home, folder, file, env } = cursorHome(t, content);

      const result = await runCli(["mcp", "install", "cursor", "--force"], { home, env });

      const start = problem === null ? `mcpServers in ${file} is not a JSON object.` : `${file} ${problem}.`;
      assert.deepEqual(result, {
        code: 1,
        stdout: "",
        stderr: `error: ${start} It was left as it is. Add this to its mcpServers by hand: ${ENTRY}\n`,
        homeEntries: [".cursor"],
      });
      assert.equal(readFileSync(file, "utf8"), content);
      assert.deepEqual(readdirSync(folder), ["mcp.json"]);
    });
  }
});

test("--dry-run shows the change to Cursor's file and writes nothing", async (t) => {
  const { home, folder, file, env } = cursorHome(t);

  const result = await runCli(["mcp", "install", "cursor", "--dry-run"], { home, env });

  assert.deepEqual(result, {
    code: 0,
    stdout: `${JSON.stringify({ dryRun: true, client: "cursor", file, change: "add", entry: { "enrichlayer-v3": { url: URL } } })}\n`,
    stderr: "",
    homeEntries: [".cursor"],
  });
  assert.deepEqual(readdirSync(folder), []);
});

test("a linked mcp.json stays a link and the file behind it gets the entry", async (t) => {
  const { home, folder, file, env } = cursorHome(t);
  const real = join(tempDir(t), "shared-mcp.json");
  writeFileSync(real, "{}\n");
  symlinkSync(real, file);

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.equal(result.code, 0);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { mcpServers: { "enrichlayer-v3": { url: URL } } });
  assert.deepEqual(readdirSync(folder), ["mcp.json"]);
});

test("without a client the clients are listed, and an unknown client is a usage error", async (t) => {
  const { env, calls } = fakeClients(t, ["claude", "codex", "code"]);

  const listed = await runCli(["mcp", "install"], { env });
  const unknown = await runCli(["mcp", "install", "claude-desktop"], { env });

  assert.deepEqual(listed, {
    code: 0,
    stdout: "Clients: claude-code, codex, vscode, cursor. Run enrichlayer-v3 mcp install <client>.\n",
    stderr: "",
    homeEntries: [],
  });
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stdout, "");
  assert.deepEqual(calls(), []);
});

const BY_HAND = `It was left as it is. Add this to its mcpServers by hand: ${ENTRY}`;
const isRoot = process.getuid?.() === 0;

function listing(folder) {
  return readdirSync(folder).sort();
}

test("a linked mcp.json whose file does not exist is refused and stays a link", async (t) => {
  const cases = [["mcp", "install", "cursor"], ["mcp", "install", "cursor", "--force"], ["mcp", "install", "cursor", "--dry-run"]];

  for (const args of cases) {
    await t.test(args.join(" "), async (t) => {
      const { home, folder, file, env } = cursorHome(t);
      const elsewhere = tempDir(t);
      const missing = join(elsewhere, "dotfiles-mcp.json");
      symlinkSync(missing, file);

      const result = await runCli(args, { home, env });

      assert.deepEqual(result, {
        code: 1,
        stdout: "",
        stderr: `error: ${file} is a link to a file that does not exist. It was left as it is. Create the file the link points to and run again; the entry to add is ${ENTRY}\n`,
        homeEntries: [".cursor"],
      });
      assert.equal(lstatSync(file).isSymbolicLink(), true);
      assert.equal(readlinkSync(file), missing);
      assert.deepEqual(listing(elsewhere), []);
      assert.deepEqual(listing(folder), ["mcp.json"]);
    });
  }
});

test("a link through another link reaches the file and both links stay", async (t) => {
  const { home, folder, file, env } = cursorHome(t);
  const elsewhere = tempDir(t);
  const real = join(elsewhere, "real.json");
  const middle = join(elsewhere, "middle.json");
  writeFileSync(real, '{"mcpServers":{}}\n');
  symlinkSync(real, middle);
  symlinkSync(middle, file);

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.equal(result.code, 0);
  assert.equal(readlinkSync(file), middle);
  assert.equal(readlinkSync(middle), real);
  assert.equal(lstatSync(real).isFile(), true);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { mcpServers: { "enrichlayer-v3": { url: URL } } });
  assert.deepEqual(listing(elsewhere), ["middle.json", "real.json"]);
  assert.deepEqual(listing(folder), ["mcp.json"]);
});

test("a .cursor that is a link to nowhere counts as no Cursor, and the link stays", async (t) => {
  const home = tempDir(t);
  const folder = join(home, ".cursor");
  const missing = join(tempDir(t), "cursor-settings");
  symlinkSync(missing, folder);

  const result = await runCli(["mcp", "install", "cursor"], { home, env: { PATH: tempDir(t) } });

  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: `error: Cursor was not found: there is no folder ${folder}. Install Cursor and open it once, then run again.\n`,
    homeEntries: [".cursor"],
  });
  assert.equal(readlinkSync(folder), missing);
  assert.equal(existsSync(missing), false);
});

test("a .cursor that is a file is refused and left as it is", async (t) => {
  const home = tempDir(t);
  const folder = join(home, ".cursor");
  writeFileSync(folder, "not a folder\n");

  const result = await runCli(["mcp", "install", "cursor"], { home, env: { PATH: tempDir(t) } });

  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: `error: ${folder} is not a folder, so Cursor's mcp.json cannot be in it. Nothing was changed.\n`,
    homeEntries: [".cursor"],
  });
  assert.equal(readFileSync(folder, "utf8"), "not a folder\n");
});

test("a folder in the place of mcp.json is refused and left as it is", async (t) => {
  const { home, folder, file, env } = cursorHome(t);
  mkdirSync(file);
  writeFileSync(join(file, "keep.txt"), "keep\n");

  const result = await runCli(["mcp", "install", "cursor", "--force"], { home, env });

  assert.deepEqual(result, { code: 1, stdout: "", stderr: `error: ${file} is not a regular file. It was left as it is.\n`, homeEntries: [".cursor"] });
  assert.deepEqual(listing(file), ["keep.txt"]);
  assert.deepEqual(listing(folder), ["mcp.json"]);
});

test("a named pipe in the place of mcp.json is refused without waiting on it", { skip: process.platform === "win32" }, async (t) => {
  const { home, folder, file, env } = cursorHome(t);
  execFileSync("mkfifo", [file]);

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(result, { code: 1, stdout: "", stderr: `error: ${file} is not a regular file. It was left as it is.\n`, homeEntries: [".cursor"] });
  assert.equal(lstatSync(file).isFIFO(), true);
  assert.deepEqual(listing(folder), ["mcp.json"]);
});

test("an mcp.json that cannot be read is refused and left as it is", { skip: isRoot }, async (t) => {
  const { home, folder, file, env } = cursorHome(t, '{"mcpServers":{}}\n', { mode: 0o200 });

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(result, { code: 1, stdout: "", stderr: `error: ${file} cannot be read (EACCES). ${BY_HAND}\n`, homeEntries: [".cursor"] });
  assert.equal(modeOf(file), 0o200);
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"mcpServers":{}}\n');
  assert.deepEqual(listing(folder), ["mcp.json"]);
});

test("a read-only mcp.json is refused and left as it is, unless the entry is already there", { skip: isRoot }, async (t) => {
  const content = '{"mcpServers":{}}\n';
  const { home, folder, file, env } = cursorHome(t, content, { mode: 0o444 });

  const result = await runCli(["mcp", "install", "cursor"], { home, env });

  assert.deepEqual(result, { code: 1, stdout: "", stderr: `error: ${file} is read-only. ${BY_HAND}\n`, homeEntries: [".cursor"] });
  assert.equal(readFileSync(file, "utf8"), content);
  assert.equal(modeOf(file), 0o444);
  assert.deepEqual(listing(folder), ["mcp.json"]);

  const present = cursorHome(t, `{"mcpServers":{"enrichlayer-v3":{"url":"${URL}"}}}`, { mode: 0o444 });

  const again = await runCli(["mcp", "install", "cursor"], { home: present.home, env: present.env });

  assert.deepEqual(again, { code: 0, stdout: `enrichlayer-v3 is already in ${present.file}.\n`, stderr: "", homeEntries: [".cursor"] });
});

test("a .cursor folder that cannot be written to is refused, with or without mcp.json", { skip: isRoot }, async (t) => {
  for (const content of [undefined, '{"mcpServers":{}}\n']) {
    await t.test(content === undefined ? "no mcp.json" : "with mcp.json", async (t) => {
      const { home, folder, file, env } = cursorHome(t, content);
      chmodSync(folder, 0o555);

      const result = await runCli(["mcp", "install", "cursor"], { home, env }).finally(() => chmodSync(folder, 0o755));

      assert.deepEqual(result, {
        code: 1,
        stdout: "",
        stderr: `error: The folder ${folder} cannot be written to, so nothing was changed. Add this to mcpServers in ${file} by hand: ${ENTRY}\n`,
        homeEntries: [".cursor"],
      });
      assert.deepEqual(listing(folder), content === undefined ? [] : ["mcp.json"]);
      if (content !== undefined) assert.equal(readFileSync(file, "utf8"), content);
    });
  }
});

test("a link to a file in a folder that cannot be written to is refused and both are left as they are", { skip: isRoot }, async (t) => {
  const { home, folder, file, env } = cursorHome(t);
  const locked = realpathSync(tempDir(t));
  const real = join(locked, "mcp.json");
  writeFileSync(real, '{"mcpServers":{}}\n');
  symlinkSync(real, file);
  chmodSync(locked, 0o555);

  const result = await runCli(["mcp", "install", "cursor"], { home, env }).finally(() => chmodSync(locked, 0o755));

  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: `error: The folder ${locked} cannot be written to, so nothing was changed. Add this to mcpServers in ${file} by hand: ${ENTRY}\n`,
    homeEntries: [".cursor"],
  });
  assert.equal(readlinkSync(file), real);
  assert.equal(readFileSync(real, "utf8"), '{"mcpServers":{}}\n');
  assert.deepEqual(listing(locked), ["mcp.json"]);
  assert.deepEqual(listing(folder), ["mcp.json"]);
});

test("for the clients with their own command nothing in the home folder is read or written", async (t) => {
  for (const client of ["claude-code", "codex", "vscode"]) {
    await t.test(client, async (t) => {
      const { env } = fakeClients(t, ["claude", "codex", "code"]);
      const home = tempDir(t);
      for (const name of [".claude.json", ".codex", ".vscode", ".cursor"]) execFileSync("mkfifo", [join(home, name)]);

      const result = await runCli(["mcp", "install", client], { home, env });

      assert.equal(result.code, 0);
      assert.deepEqual(result.homeEntries.sort(), [".claude.json", ".codex", ".cursor", ".vscode"]);
    });
  }
});
