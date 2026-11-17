import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./key-file.js";
import { isAllowedIssuer, OAuthError, type OAuthTokens } from "./oauth.js";
import { ensurePrivateDir, writePrivateJson } from "./private-dir.js";

export type SignInFileState =
  | { status: "missing" }
  | { status: "saved"; tokens: OAuthTokens }
  | { status: "exposed"; tokens: OAuthTokens; message: string }
  | { status: "unusable"; message: string };

export interface TokenStore {
  state(): SignInFileState;
  read(): Promise<OAuthTokens | null>;
  write(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

const SIGN_IN_AGAIN = "sign in again with enrichlayer-v3 auth login";
const DAMAGED = "The stored sign-in is damaged. Run enrichlayer-v3 auth login.";

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function storedTokens(value: unknown): OAuthTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { accessToken, refreshToken, expiresAt, issuer, clientId, resource } = value as Record<string, unknown>;
  if (!isText(accessToken) || !isText(refreshToken) || !isText(clientId) || !isText(resource) || !isText(issuer) || !isAllowedIssuer(issuer)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { accessToken, refreshToken, expiresAt, issuer, clientId, resource };
}

export function readSignInFile(path: string, platform: NodeJS.Platform = process.platform): SignInFileState {
  const notRegular: SignInFileState = { status: "unusable", message: `The sign-in file ${path} is not a regular file. Remove it and ${SIGN_IN_AGAIN}.` };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "missing" };
    if (code === "ELOOP") return notRegular;
    return { status: "unusable", message: `Could not read the sign-in file ${path} (${code}).` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return notRegular;
    let tokens: OAuthTokens | null;
    try {
      tokens = storedTokens(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      tokens = null;
    }
    if (!tokens) return { status: "unusable", message: DAMAGED };
    const mode = (stats.mode & 0o777).toString(8).padStart(4, "0");
    if (platform !== "win32" && (stats.mode & 0o077) !== 0)
      return { status: "exposed", tokens, message: `The sign-in file ${path} can be read by other users (mode ${mode}). Run chmod 600 ${path}, or ${SIGN_IN_AGAIN}.` };
    return { status: "saved", tokens };
  } finally {
    closeSync(fd);
  }
}

/** The sign-in, kept in session.json beside the key file with mode 0600. */
export class CredentialStore implements TokenStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, "session.json");
  }

  state(): SignInFileState {
    return readSignInFile(this.file);
  }

  async read(): Promise<OAuthTokens | null> {
    const state = this.state();
    if (state.status === "missing") return null;
    if (state.status === "saved") return state.tokens;
    throw new OAuthError(state.message);
  }

  async write(tokens: OAuthTokens): Promise<void> {
    ensurePrivateDir(this.dir);
    writePrivateJson(this.file, tokens);
  }

  async clear(): Promise<void> {
    rmSync(this.file, { force: true });
  }
}
