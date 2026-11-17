import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { USER_AGENT } from "../config.js";

export const AUTH_URL = "https://auth.enrichlayer.com";
export const CLIENT_ID = "enrichlayer-cli";
export const RESOURCE = "https://api.enrichlayer.com";
export const SCOPE = "api";

// A first sign-in (an email link, then an authenticator code) can take minutes, and an approval that
// lands after the CLI stops waiting leaves a grant with no token. 600 s is also how long a device code
// lives on auth.enrichlayer.com.
export const LOGIN_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 5_000;
const SLOW_DOWN_MS = 5_000;

export interface OAuthConfig {
  issuer: string;
  clientId: string;
  resource: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isAllowedIssuer(issuer: string): boolean {
  try {
    const { protocol, hostname } = new URL(issuer);
    return protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
  } catch {
    return false;
  }
}

export function oauthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const issuer = (env.ENRICHLAYER_AUTH_URL || AUTH_URL).replace(/\/+$/, "");
  if (!isAllowedIssuer(issuer)) throw new OAuthError("ENRICHLAYER_AUTH_URL must start with https:// (http:// only for 127.0.0.1, localhost or ::1).");
  return {
    issuer,
    clientId: env.ENRICHLAYER_CLIENT_ID || CLIENT_ID,
    resource: env.ENRICHLAYER_RESOURCE || RESOURCE,
  };
}

export interface OAuthTokens extends OAuthConfig {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "").slice(0, 100);
}

export class OAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthError";
  }

  /** An error code from the issuer. The code is untrusted text, so only its printable start is kept. */
  static fromCode(code: unknown, fallback: string): OAuthError {
    return new OAuthError(`Sign-in failed: ${typeof code === "string" && code ? printable(code) : fallback}`);
  }
}

export class SignInUnavailableError extends OAuthError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignInUnavailableError";
  }
}

const TRY_LATER = "Try again in a few minutes.";

export async function oauthPost(issuer: string, path: string, params: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${issuer}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
      body: new URLSearchParams(params),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A refresh whose answer was lost may already have rotated the refresh token, so a refresh is never
    // retried: sending the old refresh token again would revoke the grant.
    throw new SignInUnavailableError(`Could not reach the sign-in server ${issuer}. ${TRY_LATER}`, { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new OAuthError(`The sign-in server ${issuer} answered with a redirect, which the CLI does not follow. Check ENRICHLAYER_AUTH_URL.`);
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    throw new SignInUnavailableError(`The sign-in server ${issuer} is not available right now (HTTP ${response.status}). ${TRY_LATER}`);
  }
  return response;
}

const UNREADABLE = `The sign-in server sent an answer that could not be read. ${TRY_LATER}`;

export async function oauthJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch (error) {
    throw new SignInUnavailableError(UNREADABLE, { cause: error });
  }
  throw new SignInUnavailableError(UNREADABLE);
}

export async function readTokenResponse(response: Response, config: OAuthConfig, now = Date.now): Promise<OAuthTokens> {
  const data = await oauthJson(response);
  if (!response.ok) throw OAuthError.fromCode(data.error, "token_request_failed");
  const { access_token, refresh_token, expires_in, token_type } = data;
  if (
    typeof access_token !== "string" ||
    !access_token ||
    typeof refresh_token !== "string" ||
    !refresh_token ||
    typeof expires_in !== "number" ||
    !Number.isFinite(expires_in) ||
    expires_in <= 0 ||
    typeof token_type !== "string" ||
    token_type.toLowerCase() !== "bearer"
  )
    throw new SignInUnavailableError(`The sign-in server sent an incomplete token answer. ${TRY_LATER}`);
  return { accessToken: access_token, refreshToken: refresh_token, expiresAt: now() + expires_in * 1000, ...config };
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
}

export interface DeviceLoginOptions {
  onCode: (code: DeviceCode) => void;
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}

/** RFC 8628 device authorization grant: show a link and a code, then poll until the person approves. */
export async function deviceLogin(config: OAuthConfig, { onCode, wait = sleep, now = Date.now, timeoutMs = LOGIN_TIMEOUT_MS }: DeviceLoginOptions): Promise<OAuthTokens> {
  const response = await oauthPost(config.issuer, "/device/auth", { client_id: config.clientId, resource: config.resource, scope: SCOPE });
  const data = await oauthJson(response);
  if (!response.ok) throw OAuthError.fromCode(data.error, "device_authorization_failed");
  if (typeof data.user_code !== "string" || typeof data.device_code !== "string" || typeof data.expires_in !== "number" || !(data.expires_in > 0))
    throw new OAuthError("The sign-in server sent an incomplete device code answer.");
  // Never use verification_uri_complete, and accept no other link: an answer must not be able to send
  // the person to a page with a code already filled in.
  const verificationUri = `${config.issuer}/device`;
  if (data.verification_uri !== verificationUri) throw new OAuthError("The sign-in server sent an unexpected verification link.");
  onCode({ userCode: printable(data.user_code), verificationUri });

  // RFC 8628 §3.2: 5 s when the server names no interval; never poll faster than that.
  let interval = Math.max(typeof data.interval === "number" && Number.isFinite(data.interval) ? data.interval * 1000 : 0, DEFAULT_POLL_MS);
  const deadline = now() + Math.min(data.expires_in * 1000, timeoutMs);
  let failure: SignInUnavailableError | undefined;
  while (now() < deadline) {
    await wait(Math.min(interval, deadline - now()));
    if (now() >= deadline) break;
    let token: Response;
    let error: unknown;
    try {
      // The resource was bound when the code was issued; a pending code polled with `resource` is refused
      // with invalid_target (measured against auth.enrichlayer.com, 2026-11-05).
      token = await oauthPost(config.issuer, "/token", {
        client_id: config.clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: data.device_code,
      });
      if (!token.ok) error = (await oauthJson(token)).error;
    } catch (unavailable) {
      if (!(unavailable instanceof SignInUnavailableError)) throw unavailable;
      failure = unavailable;
      continue;
    }
    if (token.ok) return readTokenResponse(token, config, now);
    failure = undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += SLOW_DOWN_MS;
      continue;
    }
    if (error === "access_denied") throw new OAuthError("Sign-in was declined in the browser.");
    if (error === "expired_token") throw new OAuthError("The code expired before it was approved. Run enrichlayer-v3 auth login again.");
    throw OAuthError.fromCode(error, "device_authorization_failed");
  }
  throw failure ?? new OAuthError("The code was not approved within 10 minutes. Run enrichlayer-v3 auth login again.");
}

export class BrowserOpenError extends Error {
  constructor() {
    super("Could not open a browser");
    this.name = "BrowserOpenError";
  }
}

export function browserOpener(platform: string, windows: boolean): [string, string[]] {
  if (windows || platform === "win32") return ["rundll32.exe", ["url.dll,FileProtocolHandler"]];
  if (platform === "darwin") return ["open", []];
  return ["xdg-open", []];
}

export function openBrowser(url: string, windows = false, timeoutMs = 10_000): Promise<void> {
  const [command, args] = browserOpener(process.platform, windows);
  return new Promise((resolve, reject) => {
    execFile(command, [...args, url], { timeout: timeoutMs }, (error) => {
      // An opener still running at the timeout has started a browser (xdg-open with $BROWSER waits for
      // it), so keep waiting for the callback rather than giving up.
      if (error && !(error as { killed?: boolean }).killed) reject(new BrowserOpenError());
      else resolve();
    });
  });
}

/** The authorization code of a loopback callback, after checking its path, state and issuer (RFC 9207). */
export function callbackCode(url: URL, method: string | undefined, state: string, issuer: string): string {
  const ours = method === "GET" && url.pathname === "/callback" && url.searchParams.get("state") === state && url.searchParams.get("iss") === issuer;
  if (!ours) throw new OAuthError("The browser sent back a sign-in that does not belong to this login (state or issuer). Nothing was saved.");
  const error = url.searchParams.get("error");
  if (error === "access_denied") throw new OAuthError("Sign-in was declined in the browser. Nothing was saved.");
  if (error !== null) throw OAuthError.fromCode(error, "authorization_failed");
  const code = url.searchParams.get("code");
  if (!code) throw new OAuthError("The browser sent back no authorization code. Nothing was saved.");
  return code;
}

export interface BrowserLoginOptions {
  open: (url: string) => Promise<void>;
  onUrl: (url: string) => void;
  timeoutMs?: number;
}

/** Authorization code grant with PKCE (S256), answered on a one-shot listener on 127.0.0.1. */
export async function browserLogin(config: OAuthConfig, { open, onUrl, timeoutMs = LOGIN_TIMEOUT_MS }: BrowserLoginOptions): Promise<OAuthTokens> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codeArrived = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The callback or the timeout can arrive while the opener is still running.
  codeArrived.catch(() => {});

  let served = false;
  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || callback.pathname !== "/callback") return void res.writeHead(404, { Connection: "close" }).end();
    // Only the first callback counts: a second callback cannot replace the first.
    if (served) return void res.writeHead(410, { Connection: "close" }).end();
    served = true;
    server.close();
    try {
      const code = callbackCode(callback, req.method, state, config.issuer);
      res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" }).end("Signed in. Return to the terminal.");
      resolveCode(code);
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" }).end("Sign-in rejected. Return to the terminal.");
      rejectCode(error as Error);
    }
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the local sign-in listener");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL(`${config.issuer}/auth`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      resource: config.resource,
      scope: SCOPE,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    onUrl(url.toString());
    timer = setTimeout(
      () => rejectCode(new OAuthError("The browser sign-in was not completed within 10 minutes. To use a link and a code instead, run: enrichlayer-v3 auth login --no-browser")),
      timeoutMs,
    );
    const code = await Promise.race([codeArrived, Promise.resolve().then(() => open(url.toString())).then(() => codeArrived)]);
    const response = await oauthPost(config.issuer, "/token", {
      client_id: config.clientId,
      resource: config.resource,
      scope: SCOPE,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return await readTokenResponse(response, config);
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

/** Revoke the refresh token at the issuer. Returns false when the issuer did not confirm. */
export async function revokeTokens(tokens: OAuthTokens): Promise<boolean> {
  try {
    const response = await oauthPost(tokens.issuer, "/token/revocation", {
      token: tokens.refreshToken,
      token_type_hint: "refresh_token",
      client_id: tokens.clientId,
      resource: tokens.resource,
      scope: SCOPE,
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export interface Identity {
  sub: string | null;
  clientId: string;
  grantId: string | null;
}

/** Who the access token is for. Display only: the API checks the token itself. */
export function tokenIdentity(tokens: OAuthTokens): Identity {
  try {
    const claims = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1] ?? "", "base64url").toString());
    const text = (value: unknown) => (typeof value === "string" ? printable(value) : null);
    return { sub: text(claims.sub), clientId: text(claims.client_id) ?? tokens.clientId, grantId: text(claims.grant_id ?? claims.gid) };
  } catch {
    return { sub: null, clientId: tokens.clientId, grantId: null };
  }
}

export interface LoginEnvironment {
  platform: string;
  noBrowser: boolean;
  env: NodeJS.ProcessEnv;
  docker: boolean;
  procVersion: string;
}

export type LoginMethod = "browser" | "windows" | "device";

/** The same choice the v2 CLI makes; pure, so it can be tested as a table. */
export function selectLoginMethod(e: LoginEnvironment): LoginMethod {
  // A TTY says nothing about whether the machine has a screen.
  if (e.noBrowser) return "device";
  if (["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].some((key) => e.env[key] !== undefined)) return "device";
  if (e.env.CI !== undefined || e.docker || e.env.container !== undefined) return "device";
  // WSL has a Windows desktop even when no Linux display server runs.
  if (e.env.WSL_DISTRO_NAME !== undefined || /microsoft/i.test(e.procVersion)) return "windows";
  if (e.platform === "linux" && !e.env.DISPLAY && !e.env.WAYLAND_DISPLAY) return "device";
  return "browser";
}

export function loginEnvironment(noBrowser: boolean, env: NodeJS.ProcessEnv = process.env): LoginEnvironment {
  let procVersion = "";
  try {
    procVersion = readFileSync("/proc/version", "utf8");
  } catch {
    // only Linux has /proc
  }
  return { platform: process.platform, noBrowser, env, docker: existsSync("/.dockerenv"), procVersion };
}
