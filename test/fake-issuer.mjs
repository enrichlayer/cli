import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../build/auth/token-store.js";

export const CLIENT_ID = "enrichlayer-cli";
export const RESOURCE = "https://api.enrichlayer.com";

export function accessToken(n) {
  const claims = { sub: "account-123", client_id: CLIENT_ID, grant_id: "grant-1", n };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig-${n}`;
}

/**
 * An in-process auth.enrichlayer.com: authorization code with PKCE, device grant, rotating refresh
 * tokens that revoke the grant when a used one is presented again, and revocation.
 */
export async function startIssuer(t) {
  const state = {
    requests: [],
    refreshCount: 0,
    revoked: false,
    refreshToken: "refresh-0",
    accessToken: accessToken(0),
    refreshDelayMs: 0,
    revokeStatus: 200,
    deviceErrors: [],
    deviceInterval: 1,
    deviceExpiresIn: 600,
    verificationUri: undefined,
    pending: null,
  };
  const pair = () => ({ access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 600, token_type: "Bearer" });

  async function handle(path, params) {
    if (path === "/auth") {
      state.pending = { challenge: params.get("code_challenge"), redirect: params.get("redirect_uri") };
      return [200, {}];
    }
    if (path === "/device/auth")
      return [
        200,
        {
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: state.verificationUri ?? `${issuer.url}/device`,
          verification_uri_complete: `${issuer.url}/device?user_code=ABCD-EFGH`,
          interval: state.deviceInterval,
          expires_in: state.deviceExpiresIn,
        },
      ];
    if (path === "/token/revocation") {
      if (state.revokeStatus === 200) state.revoked = true;
      return [state.revokeStatus, {}];
    }
    if (path !== "/token") return [404, {}];
    const grant = params.get("grant_type");
    if (grant === "refresh_token") {
      state.refreshCount++;
      if (state.revoked || params.get("refresh_token") !== state.refreshToken) {
        // Reuse of a rotated refresh token revokes the whole grant.
        state.revoked = true;
        return [400, { error: "invalid_grant" }];
      }
      state.refreshToken = `refresh-${state.refreshCount}`;
      state.accessToken = accessToken(state.refreshCount);
      await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
      return [200, pair()];
    }
    if (grant === "authorization_code") {
      const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      const valid = params.get("code") === "auth-code" && state.pending && challenge === state.pending.challenge && params.get("redirect_uri") === state.pending.redirect;
      return valid ? [200, pair()] : [400, { error: "invalid_grant" }];
    }
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      if (params.has("resource")) return [400, { error: "invalid_target" }];
      const error = state.deviceErrors.shift();
      if (error) return [400, { error }];
      return params.get("device_code") === "device-secret" ? [200, pair()] : [400, { error: "invalid_grant" }];
    }
    return [400, { error: "unsupported_grant_type" }];
  }

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://127.0.0.1");
    const params = req.method === "GET" ? url.searchParams : new URLSearchParams(body);
    state.requests.push({ path: url.pathname, params });
    const [status, value] = await handle(url.pathname, params);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    config() {
      return { issuer: this.url, clientId: CLIENT_ID, resource: RESOURCE };
    },
    /** The pair the issuer considers current, as the CLI would have stored it. */
    tokens(expiresInMs = 600_000) {
      return { accessToken: state.accessToken, refreshToken: state.refreshToken, expiresAt: Date.now() + expiresInMs, ...this.config() };
    },
    tokenRequests(grant) {
      return state.requests.filter((r) => r.path === "/token" && (!grant || r.params.get("grant_type") === grant));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
  t.after(issuer.close);
  return issuer;
}

export const noKeychain = async () => {
  throw new Error("no keychain in tests");
};

/** A file store in a fresh directory that also holds the lock. */
export function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "enrichlayer-cli-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new CredentialStore(dir, noKeychain) };
}
