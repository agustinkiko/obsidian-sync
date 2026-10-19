import { requestUrl } from "obsidian";

export const PROTOCOL_ACTION = "gdrive-sync-auth";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface PendingLogin {
  state: string;
  verifier: string;
}

export interface Tokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

/** Google OAuth client entered in the plugin settings. The secret never leaves Obsidian. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Builds the Google sign-in URL and the secrets we must remember until Google sends us back. */
export async function createLogin(client: OAuthClient): Promise<{ url: string; pending: PendingLogin }> {
  const verifier = randomString(48);
  const state = randomString(24);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), pending: { state, verifier } };
}

async function tokenRequest(client: OAuthClient, params: Record<string, string>): Promise<Tokens> {
  const res = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...params,
    }).toString(),
    throw: false,
  });
  const data = res.json ?? {};
  if (res.status !== 200 || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google returned ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    refreshToken: data.refresh_token,
  };
}

export function exchangeCode(client: OAuthClient, code: string, verifier: string): Promise<Tokens> {
  return tokenRequest(client, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: client.redirectUri,
  });
}

export function refreshAccessToken(client: OAuthClient, refreshToken: string): Promise<Tokens> {
  return tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/**
 * Reads code/state/error from a pasted sign-in link. Accepts the obsidian:// link shown on the
 * relay page, or the relay's /callback URL copied from the browser's address bar.
 */
export function parseSignInLink(link: string): Record<string, string> | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const params: Record<string, string> = {};
  for (const key of ["code", "state", "error"]) {
    const v = url.searchParams.get(key);
    if (v) params[key] = v;
  }
  return params.code || params.error ? params : null;
}

export async function revoke(token: string): Promise<void> {
  await requestUrl({
    url: `${REVOKE_URL}?token=${encodeURIComponent(token)}`,
    method: "POST",
    throw: false,
  });
}
