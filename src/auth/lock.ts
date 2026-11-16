import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensurePrivateDir } from "./private-dir.js";

const ABANDONED_MS = 600_000;

type Holder = "alive" | "dead" | "unknown";

function holder(path: string): Holder {
  let pid: number;
  try {
    pid = Number(readFileSync(path, "utf8"));
  } catch {
    return "unknown";
  }
  // An empty lock is one whose holder has not written its pid yet.
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}

/**
 * Remove a lock whose holder has exited at once, one without a pid after staleMs, and any lock after
 * ten minutes, whoever holds it.
 */
function breakIfStale(path: string, staleMs: number): void {
  try {
    const stat = statSync(path);
    const age = Date.now() - stat.mtimeMs;
    const state = holder(path);
    const stale = state === "dead" || (state === "unknown" && age > staleMs) || age > ABANDONED_MS;
    if (stale && statSync(path).ino === stat.ino) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Run action while holding session.lock in dir, so that only one process at a time exchanges the
 * refresh token. Refresh tokens rotate, and presenting a used one revokes the whole grant.
 */
export async function withCredentialLock<T>(
  dir: string,
  action: () => Promise<T>,
  staleMs = 120_000,
  waitMs = staleMs + 15_000,
  onWait: (path: string) => void = (path) => process.stderr.write(`Waiting for another enrichlayer-v3 process that holds ${path}\n`),
): Promise<T> {
  ensurePrivateDir(dir);
  const path = join(dir, "session.lock");
  const deadline = Date.now() + waitMs;
  let waited = false;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      breakIfStale(path, staleMs);
      if (!waited && existsSync(path)) onWait(path);
      waited = true;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the sign-in lock ${path}`);
      await sleep(50);
      continue;
    }

    const inode = statSync(path).ino;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      closeSync(fd);
      if (existsSync(path) && statSync(path).ino === inode) unlinkSync(path);
    };
    const exitOn = (code: number) => () => {
      try {
        release();
      } finally {
        process.exit(code);
      }
    };
    const interrupt = exitOn(130);
    const terminate = exitOn(143);
    const hangUp = exitOn(129);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    process.once("SIGHUP", hangUp);
    try {
      writeFileSync(fd, String(process.pid));
      return await action();
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", hangUp);
      release();
    }
  }
}
