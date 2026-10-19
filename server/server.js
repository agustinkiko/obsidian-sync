// Tiny OAuth helper for the Obsidian Google Drive Sync plugin.
// It holds the Google client secret so the plugin never has to.
// It stores nothing: no database, no logs of tokens.
//
// Endpoints:
//   GET  /start?state=..&code_challenge=..  -> redirects to Google sign-in
//   GET  /callback?code=..&state=..         -> hands the code back to Obsidian (obsidian:// link)
//   POST /token   {code, code_verifier}     -> exchanges code for tokens
//   POST /refresh {refresh_token}           -> gets a fresh access token
//   GET  /healthz                           -> "ok"

"use strict";

const http = require("node:http");

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8080);

if (!CLIENT_ID || !CLIENT_SECRET || !PUBLIC_URL) {
  console.error("Missing env: CLIENT_ID, CLIENT_SECRET and PUBLIC_URL are required.");
  process.exit(1);
}

const REDIRECT_URI = `${PUBLIC_URL}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const OBSIDIAN_ACTION = "gdrive-sync-auth";
const SAFE_PARAM = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_BODY = 16 * 1024;

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

async function googleToken(params) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...params,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function handleStart(res, url) {
  const state = url.searchParams.get("state") || "";
  const challenge = url.searchParams.get("code_challenge") || "";
  if (!SAFE_PARAM.test(state) || !SAFE_PARAM.test(challenge)) {
    return send(res, 400, "Bad request", { "Content-Type": "text/plain" });
  }
  const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  google.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  send(res, 302, "", { Location: google.toString() });
}

function handleCallback(res, url) {
  const out = new URLSearchParams();
  for (const key of ["code", "state", "error"]) {
    const v = url.searchParams.get(key);
    if (v) out.set(key, v);
  }
  const target = `obsidian://${OBSIDIAN_ACTION}?${out.toString()}`;
  const failed = url.searchParams.has("error");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obsidian Google Drive Sync</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 15vh auto; padding: 0 1rem; text-align: center; }
  a.btn { display: inline-block; padding: .8rem 1.4rem; border-radius: .5rem; background: #7c3aed; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<h1>${failed ? "Sign-in was cancelled" : "Almost done"}</h1>
<p>${failed ? "You can close this page and try again from Obsidian." : "Tap the button to return to Obsidian."}</p>
<p><a class="btn" href="${escapeHtml(target)}">Open Obsidian</a></p>
<script>setTimeout(function () { location.href = ${JSON.stringify(target)}; }, 300);</script>
</body>
</html>`;
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
}

async function handleToken(req, res) {
  const { code, code_verifier } = await readJson(req);
  if (typeof code !== "string" || typeof code_verifier !== "string") {
    return sendJson(res, 400, { error: "code and code_verifier are required" });
  }
  const { status, data } = await googleToken({
    grant_type: "authorization_code",
    code,
    code_verifier,
    redirect_uri: REDIRECT_URI,
  });
  sendJson(res, status, data);
}

async function handleRefresh(req, res) {
  const { refresh_token } = await readJson(req);
  if (typeof refresh_token !== "string") {
    return sendJson(res, 400, { error: "refresh_token is required" });
  }
  const { status, data } = await googleToken({ grant_type: "refresh_token", refresh_token });
  sendJson(res, status, data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok");
    if (req.method === "GET" && url.pathname === "/start") return handleStart(res, url);
    if (req.method === "GET" && url.pathname === "/callback") return handleCallback(res, url);
    if (req.method === "POST" && url.pathname === "/token") return await handleToken(req, res);
    if (req.method === "POST" && url.pathname === "/refresh") return await handleRefresh(req, res);
    send(res, 404, "Not found", { "Content-Type": "text/plain" });
  } catch (err) {
    console.error(`${req.method} ${req.url?.split("?")[0]} failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
  }
});

server.listen(PORT, () => console.log(`listening on :${PORT}, public url ${PUBLIC_URL}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
