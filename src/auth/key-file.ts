import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const AUTH_SAVE = "enrichlayer-v3 auth save";

export interface KeyFilePlace {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function keyFilePath({ platform = process.platform, env = process.env, home = homedir() }: KeyFilePlace = {}): string {
  const path = platform === "win32" ? win32 : posix;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "enrichlayer-v3", "credentials.json");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "enrichlayer-v3", "credentials.json");
  return path.join(home, ".config", "enrichlayer-v3", "credentials.json");
}

export type KeyFileState =
  | { status: "missing" }
  | { status: "saved"; key: string }
  | { status: "unusable"; reason: string; message: string };

export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown error";
}

function notRegular(path: string): KeyFileState {
  return {
    status: "unusable",
    reason: "not a regular file",
    message: `The key file ${path} is not a regular file. Remove it and save the key again with ${AUTH_SAVE}.`,
  };
}

export function readKeyFile(path: string, platform: NodeJS.Platform = process.platform): KeyFileState {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "missing" };
    if (code === "ELOOP") return notRegular(path);
    return { status: "unusable", reason: `cannot be read, ${code}`, message: `Could not read the key file ${path} (${code}).` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return notRegular(path);
    const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
    if (platform !== "win32" && (stats.mode & 0o077) !== 0)
      return {
        status: "unusable",
        reason: `readable by other users, mode ${mode}`,
        message: `The key file ${path} can be read by other users (mode ${mode}). Run chmod 600 ${path}, or save the key again with ${AUTH_SAVE}.`,
      };
    let apiKey: unknown;
    try {
      apiKey = (JSON.parse(readFileSync(fd, "utf8")) as { apiKey?: unknown } | null)?.apiKey;
    } catch {
      apiKey = undefined;
    }
    if (typeof apiKey !== "string" || apiKey.trim() === "")
      return {
        status: "unusable",
        reason: "not valid",
        message: `The key file ${path} is not valid. Save the key again with ${AUTH_SAVE}, or remove it with enrichlayer-v3 auth remove.`,
      };
    return { status: "saved", key: apiKey };
  } finally {
    closeSync(fd);
  }
}

export function saveKeyFile(path: string, key: string, platform: NodeJS.Platform = process.platform): void {
  const directory = (platform === "win32" ? win32 : posix).dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32" && statSync(directory).uid === process.getuid?.()) chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ apiKey: key })}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeKeyFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
