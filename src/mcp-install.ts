import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, readFileSync, realpathSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MCP_SERVER_NAME = "enrichlayer-v3";
export const MCP_SERVER_URL = "https://mcp.enrichlayer.com/v3/mcp";
export const MCP_CLIENTS = ["claude-code", "codex", "vscode", "cursor"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

const CURSOR_ENTRY = { url: MCP_SERVER_URL };
const CURSOR_ENTRY_TEXT = `"${MCP_SERVER_NAME}": ${JSON.stringify(CURSOR_ENTRY)}`;

interface ClientCommand {
  title: string;
  program: string;
  args: string[];
  next: string[];
  install?: string;
  refused?: string;
}

const CLIENT_COMMANDS: Record<Exclude<McpClient, "cursor">, ClientCommand> = {
  "claude-code": {
    title: "Claude Code",
    program: "claude",
    args: ["mcp", "add", "--scope", "user", "--transport", "http", MCP_SERVER_NAME, MCP_SERVER_URL],
    next: [
      `To sign in, run /mcp in Claude Code or claude mcp login ${MCP_SERVER_NAME}.`,
      `In a folder where you added the local ${MCP_SERVER_NAME} server, Claude Code keeps using it: run claude mcp remove ${MCP_SERVER_NAME} --scope local in that folder.`,
    ],
    refused: `If your user settings already have the local ${MCP_SERVER_NAME} server, remove it with claude mcp remove ${MCP_SERVER_NAME} --scope user and run this again.`,
  },
  codex: {
    title: "Codex",
    program: "codex",
    args: ["mcp", "add", MCP_SERVER_NAME, "--url", MCP_SERVER_URL],
    next: [
      `To sign in, run codex mcp login ${MCP_SERVER_NAME}. Codex stops a tool call after 60 seconds by default; for live lookups set tool_timeout_sec = 310 under [mcp_servers.${MCP_SERVER_NAME}] in ~/.codex/config.toml.`,
      `Codex replaces an ${MCP_SERVER_NAME} entry that was already in ~/.codex/config.toml, such as the local server.`,
    ],
    refused: "If Codex does not know mcp add, update Codex: older versions do not have it.",
  },
  vscode: {
    title: "VS Code",
    program: "code",
    args: ["--add-mcp", JSON.stringify({ name: MCP_SERVER_NAME, type: "http", url: MCP_SERVER_URL })],
    next: [
      "VS Code opens the Enrich Layer sign-in page when the server first starts.",
      `VS Code replaces an ${MCP_SERVER_NAME} entry that was already in your user profile, such as the local server; one in a workspace's .vscode/mcp.json stays, so delete it there.`,
    ],
    install: `Install VS Code or, if it is installed, add code to PATH (on macOS, run "Shell Command: Install 'code' command in PATH" from the Command Palette)`,
  },
};

export type InstallPlan =
  | { action: "run"; title: string; program: string; args: string[]; command: string; next: string[]; install: string; refused?: string }
  | { action: "write"; file: string; target: string; replaces: boolean; text: string; mode: number }
  | { action: "none"; file: string }
  | { action: "refuse"; message: string };

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursorEntry(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 1 && value.url === MCP_SERVER_URL;
}

function statsOf(path: string, read: (path: string) => Stats): Stats | null {
  try {
    return read(path);
  } catch {
    return null;
  }
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function planCursor({ home, force }: { home: string; force: boolean }): InstallPlan {
  const folder = join(home, ".cursor");
  const file = join(folder, "mcp.json");
  const refuse = (message: string): InstallPlan => ({ action: "refuse", message });
  const leftAlone = "It was left as it is.";
  const byHand = `${leftAlone} Add this to its mcpServers by hand: ${CURSOR_ENTRY_TEXT}`;

  const folderStats = statsOf(folder, statSync);
  if (!folderStats) return refuse(`Cursor was not found: there is no folder ${folder}. Install Cursor and open it once, then run again.`);
  if (!folderStats.isDirectory()) return refuse(`${folder} is not a folder, so Cursor's mcp.json cannot be in it. Nothing was changed.`);

  const stats = statsOf(file, statSync);
  if (!stats && statsOf(file, lstatSync))
    return refuse(`${file} is a link to a file that does not exist. ${leftAlone} Create the file the link points to and run again; the entry to add is ${CURSOR_ENTRY_TEXT}`);
  if (stats && !stats.isFile()) return refuse(`${file} is not a regular file. ${leftAlone}`);
  let before = "";
  if (stats) {
    try {
      before = readFileSync(file, "utf8");
    } catch (error) {
      return refuse(`${file} cannot be read (${(error as NodeJS.ErrnoException).code}). ${byHand}`);
    }
  }
  let config: unknown = {};
  if (before.trim() !== "") {
    try {
      config = JSON.parse(before);
    } catch {
      return { action: "refuse", message: `${file} is not valid JSON. ${byHand}` };
    }
  }
  if (!isPlainObject(config)) return { action: "refuse", message: `${file} does not hold a JSON object. ${byHand}` };
  const servers = config.mcpServers ?? {};
  if (!isPlainObject(servers)) return { action: "refuse", message: `mcpServers in ${file} is not a JSON object. ${byHand}` };

  const replaces = Object.hasOwn(servers, MCP_SERVER_NAME);
  if (isCursorEntry(servers[MCP_SERVER_NAME])) return { action: "none", file };
  if (replaces && !force)
    return { action: "refuse", message: `${file} already has a different ${MCP_SERVER_NAME} entry, such as the local server. Run again with --force to replace it with ${CURSOR_ENTRY_TEXT}` };

  const target = stats ? realpathSync(file) : file;
  if (!isWritable(dirname(target)))
    return refuse(`The folder ${dirname(target)} cannot be written to, so nothing was changed. Add this to mcpServers in ${file} by hand: ${CURSOR_ENTRY_TEXT}`);
  if (stats && !isWritable(target)) return refuse(`${file} is read-only. ${byHand}`);

  const indent = /^([ \t]+)"/m.exec(before)?.[1] ?? "  ";
  const text = `${JSON.stringify({ ...config, mcpServers: { ...servers, [MCP_SERVER_NAME]: CURSOR_ENTRY } }, null, indent)}\n`;
  return { action: "write", file, target, replaces, text, mode: stats ? stats.mode & 0o777 : 0o600 };
}

export function planInstall({ client, force = false, home = homedir() }: { client: McpClient; force?: boolean; home?: string }): InstallPlan {
  if (client === "cursor") return planCursor({ home, force });
  const { title, program, args, next, install = `Install ${title}`, refused } = CLIENT_COMMANDS[client];
  return { action: "run", title, program, args, command: [program, ...args].map(quote).join(" "), next, install, refused };
}

export function describePlan(plan: Exclude<InstallPlan, { action: "refuse" }>): Record<string, unknown> {
  if (plan.action === "run") return { run: plan.command };
  if (plan.action === "none") return { file: plan.file, change: "none, the entry is already there" };
  return { file: plan.file, change: plan.replaces ? "replace" : "add", entry: { [MCP_SERVER_NAME]: CURSOR_ENTRY } };
}

export interface InstallOutcome {
  lines: string[];
  error?: string;
}

function writeInOneStep({ target, text, mode }: { target: string; text: string; mode: number }): void {
  const temporary = join(dirname(target), `.mcp.json.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function applyInstall(plan: InstallPlan): InstallOutcome {
  if (plan.action === "refuse") return { lines: [], error: plan.message };
  if (plan.action === "none") return { lines: [`${MCP_SERVER_NAME} is already in ${plan.file}.`] };
  if (plan.action === "write") {
    writeInOneStep(plan);
    return {
      lines: [
        `${plan.replaces ? "Replaced" : "Added"} ${MCP_SERVER_NAME} in ${plan.file}.`,
        "Cursor opens the Enrich Layer sign-in page when it connects to the server.",
        `To remove the server, delete the ${MCP_SERVER_NAME} entry from that file.`,
      ],
    };
  }

  const result = spawnSync(plan.program, plan.args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error)
    return {
      lines: [],
      error:
        (result.error as NodeJS.ErrnoException).code === "ENOENT"
          ? `The ${plan.program} command of ${plan.title} was not found. ${plan.install}, or run this where it is installed: ${plan.command}`
          : `Could not run ${plan.program}: ${result.error.message}`,
    };
  if (result.status !== 0)
    return {
      lines: [],
      error: `${plan.title} did not add the server: ${plan.program} exited with ${result.status ?? result.signal}.${plan.refused ? ` ${plan.refused}` : ""} The command was: ${plan.command}`,
    };
  return { lines: [`Added ${MCP_SERVER_NAME} (${MCP_SERVER_URL}) to ${plan.title}.`, ...plan.next] };
}
