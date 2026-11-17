import { dirname } from "node:path";
import { apiKeyCredentials, type Credentials, DASHBOARD_URL, isKeyInEnv, SIGN_IN_SOURCE } from "./api-key.js";
import { keyFilePath, readKeyFile } from "./key-file.js";
import { withCredentialLock } from "./lock.js";
import { type OAuthConfig, OAuthError, type OAuthTokens, oauthConfig, oauthJson, oauthPost, readTokenResponse, SCOPE } from "./oauth.js";
import { CredentialStore, type TokenStore } from "./token-store.js";

/** Refresh this long before the access token expires, so it does not expire on the way. */
const REFRESH_MARGIN_MS = 60_000;
const SIGN_IN_AGAIN = "Run enrichlayer-v3 auth login to sign in again.";

export class NotSignedInError extends Error {
  constructor() {
    super(
      `Not signed in and no API key. Sign in with enrichlayer-v3 auth login, or save a key with enrichlayer-v3 auth save, set ENRICHLAYER_API_KEY or pass --api-key; create a key at ${DASHBOARD_URL}.`,
    );
    this.name = "NotSignedInError";
  }
}

export interface SignInOptions {
  store: TokenStore;
  lockDir: string;
  config?: OAuthConfig;
  now?: () => number;
}

/** A stored sign-in behind the Credentials interface: refreshed before expiry and after a 401. */
export class SignInCredentials implements Credentials {
  readonly source = SIGN_IN_SOURCE;
  private readonly store: TokenStore;
  private readonly lockDir: string;
  private readonly config: OAuthConfig;
  private readonly now: () => number;
  // Set while a refresh exchange is unconfirmed and cleared only once the rotated pair is stored. A
  // refresh that failed or lost its answer may already have rotated the refresh token, so this process
  // must never present the old one again.
  private refreshUnconfirmed = false;
  private lastRefreshToken: string | undefined;
  private readonly refreshedHere = new Set<string>();

  constructor({ store, lockDir, config = oauthConfig(), now = Date.now }: SignInOptions) {
    this.store = store;
    this.lockDir = lockDir;
    this.config = config;
    this.now = now;
  }

  async tokens(): Promise<OAuthTokens> {
    const tokens = await this.store.read();
    if (!tokens) throw new NotSignedInError();
    if (tokens.issuer !== this.config.issuer || tokens.clientId !== this.config.clientId || tokens.resource !== this.config.resource)
      throw new OAuthError("The stored sign-in is for another sign-in server, client or API. Run enrichlayer-v3 auth login.");
    return tokens;
  }

  async authorization(): Promise<string> {
    const tokens = await this.tokens();
    this.lastRefreshToken = tokens.refreshToken;
    if (tokens.expiresAt - this.now() >= REFRESH_MARGIN_MS) return `Bearer ${tokens.accessToken}`;
    return `Bearer ${await this.refresh(tokens.accessToken, false)}`;
  }

  async refreshAfter401(rejected: string): Promise<string | null> {
    const token = rejected.replace(/^Bearer /, "");
    // A token this process has just been given is not made valid by asking again.
    if (this.refreshedHere.has(token)) return null;
    return `Bearer ${await this.refresh(token, true)}`;
  }

  private async refresh(previous: string, force: boolean): Promise<string> {
    const previousRefreshToken = this.lastRefreshToken;
    try {
      return await withCredentialLock(this.lockDir, async () => {
        // Another process may have refreshed while this one waited for the lock: use its pair.
        const current = await this.tokens();
        if (
          current.accessToken !== previous ||
          (previousRefreshToken !== undefined && current.refreshToken !== previousRefreshToken) ||
          (!force && current.expiresAt - this.now() >= REFRESH_MARGIN_MS)
        ) {
          this.lastRefreshToken = current.refreshToken;
          return current.accessToken;
        }
        if (this.refreshUnconfirmed) throw new OAuthError("An earlier refresh of the sign-in did not complete. Run enrichlayer-v3 auth login.");
        this.refreshUnconfirmed = true;
        const { issuer, clientId, resource } = current;
        const response = await oauthPost(issuer, "/token", {
          client_id: clientId,
          resource,
          scope: SCOPE,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        });
        if (!response.ok) {
          const { error: code } = await oauthJson(response);
          if (code === "invalid_grant") throw new OAuthError(`The sign-in has expired or was revoked. ${SIGN_IN_AGAIN}`);
          throw new OAuthError(`${OAuthError.fromCode(code, "token_request_failed").message}. ${SIGN_IN_AGAIN}`);
        }
        const next = await readTokenResponse(response, { issuer, clientId, resource }, this.now);
        // The rotated pair must be saved before another process may refresh.
        try {
          await this.store.write(next);
        } catch (error) {
          throw new OAuthError("Could not save the refreshed sign-in. If the next command fails, run enrichlayer-v3 auth login.", { cause: error });
        }
        this.lastRefreshToken = next.refreshToken;
        this.refreshUnconfirmed = false;
        this.refreshedHere.add(next.accessToken);
        return next.accessToken;
      });
    } catch (error) {
      if (error instanceof OAuthError || error instanceof NotSignedInError) throw error;
      throw new OAuthError(`${error instanceof Error ? error.message : "The refresh failed"}. If the next command fails, run enrichlayer-v3 auth login.`, { cause: error });
    }
  }
}

function failing(source: string, error: () => Error): Credentials {
  return {
    source,
    authorization() {
      throw error();
    },
  };
}

export interface ResolveOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  keyFile?: string;
  store?: TokenStore;
  lockDir?: string;
}

/** The folder of the key file: the sign-in and its lock live beside it. */
export function sessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(keyFilePath({ env }));
}

export function defaultStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  return new CredentialStore(sessionDir(env));
}

/** True when a key decides the credential: --api-key, a non-empty ENRICHLAYER_API_KEY, or a key file, usable or not. */
export function keyDecides(flag: string | undefined, env: NodeJS.ProcessEnv, keyFile: string): boolean {
  return flag !== undefined || isKeyInEnv(env) || readKeyFile(keyFile).status !== "missing";
}

/**
 * --api-key, then ENRICHLAYER_API_KEY (an empty value counts as unset), then the key file, then the
 * stored sign-in. Whenever a key is given or saved, the key credentials are returned unchanged, so a
 * key user sees exactly what they saw before sign-in existed; a key file that cannot be used still
 * stops the call rather than quietly switching to the sign-in.
 */
export async function resolveCredentials({ flag, env = process.env, keyFile = keyFilePath({ env }), store, lockDir }: ResolveOptions = {}): Promise<Credentials> {
  if (keyDecides(flag, env, keyFile)) return apiKeyCredentials({ flag, env, file: keyFile });
  const tokens = store ?? defaultStore(env);
  if (!(await tokens.read())) return failing(SIGN_IN_SOURCE, () => new NotSignedInError());
  return new SignInCredentials({ store: tokens, lockDir: lockDir ?? sessionDir(env), config: oauthConfig(env) });
}
