import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type KeychainEntry, openKeychain } from "./keychain.js";
import type { OAuthTokens } from "./oauth.js";
import { ensurePrivateDir, writePrivateJson } from "./private-dir.js";

export interface TokenStore {
  read(): Promise<OAuthTokens | null>;
  write(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

function readDocument(file: string): Record<string, unknown> | null | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The OS keychain, with a mode-0600 session.json beside the key file when it is not available. */
export class CredentialStore implements TokenStore {
  readonly file: string;

  constructor(
    readonly dir: string,
    private readonly keychain: () => Promise<KeychainEntry> = openKeychain,
  ) {
    this.file = join(dir, "session.json");
  }

  async read(): Promise<OAuthTokens | null> {
    const data = readDocument(this.file);
    if (data === null) return null;
    // A file written as the fallback wins even if the keychain later answers with an older pair;
    // {"oauth": null} records a logout the keychain could not take.
    if (data && Object.hasOwn(data, "oauth")) return data.oauth as OAuthTokens | null;
    try {
      const value = (await this.keychain()).getPassword();
      return value ? (JSON.parse(value) as OAuthTokens) : null;
    } catch {
      return null;
    }
  }

  async write(tokens: OAuthTokens): Promise<void> {
    ensurePrivateDir(this.dir);
    try {
      (await this.keychain()).setPassword(JSON.stringify(tokens));
    } catch {
      writePrivateJson(this.file, { oauth: tokens });
      return;
    }
    if (existsSync(this.file)) unlinkSync(this.file);
  }

  async clear(): Promise<void> {
    const corrupt = readDocument(this.file) === null;
    try {
      (await this.keychain()).deletePassword();
    } catch {
      if (corrupt) return unlinkSync(this.file);
      // Record the logout even when a keychain that cannot be reached still holds an old pair.
      ensurePrivateDir(this.dir);
      writePrivateJson(this.file, { oauth: null });
      return;
    }
    if (existsSync(this.file)) unlinkSync(this.file);
  }
}
