import { requestUrl } from "obsidian";

export const PROTOCOL_ACTION = "gdrive-sync-auth";

export interface PendingLogin {
  state: string;
  verifier: string;
}

export interface Tokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** Builds the sign-in URL and the secrets we must remember until Google sends us back. */
export async function createLogin(serverUrl: string): Promise<{ url: string; pending: PendingLogin }> {
  const verifier = randomString(48);
  const state = randomString(24);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const params = new URLSearchParams({ state, code_challenge: challenge });
  return { url: `${serverUrl}/start?${params}`, pending: { state, verifier } };
}

async function post(serverUrl: string, path: string, body: object): Promise<Tokens> {
  const res = await requestUrl({
    url: `${serverUrl}${path}`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify(body),
    throw: false,
  });
  const data = res.json ?? {};
  if (res.status !== 200 || !data.access_token) {
    throw new Error(data.error_description || data.error || `Auth server returned ${res.status}`);
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    refreshToken: data.refresh_token,
  };
}

export function exchangeCode(serverUrl: string, code: string, verifier: string): Promise<Tokens> {
  return post(serverUrl, "/token", { code, code_verifier: verifier });
}

export function refreshAccessToken(serverUrl: string, refreshToken: string): Promise<Tokens> {
  return post(serverUrl, "/refresh", { refresh_token: refreshToken });
}

export async function revoke(token: string): Promise<void> {
  await requestUrl({
    url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    method: "POST",
    throw: false,
  });
}
