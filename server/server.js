// Redirect relay for the Obsidian Google Drive Sync plugin.
// Google sends the browser here after sign-in. This page hands the code back to Obsidian
// through an obsidian:// link. It holds no secrets, stores nothing, and never sees a token.
// The plugin talks to Google directly, using the client ID and secret entered in its settings.
//
// Endpoints:
//   GET /callback?code=..&state=..  -> opens Obsidian (obsidian://gdrive-sync-auth?...)
//   GET /healthz                    -> "ok"

"use strict";

const http = require("node:http");

const PORT = Number(process.env.PORT || 8080);
const OBSIDIAN_ACTION = "gdrive-sync-auth";

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
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
  .fallback { margin-top: 2.5rem; color: #555; font-size: .9rem; }
  .fallback input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; font-size: .8rem; }
  .fallback button { margin-top: .5rem; padding: .5rem 1rem; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<h1>${failed ? "Sign-in was cancelled" : "Almost done"}</h1>
<p>${failed ? "You can close this page and try again from Obsidian." : "Tap the button to return to Obsidian."}</p>
<p><a class="btn" href="${escapeHtml(target)}">Open Obsidian</a></p>
${failed ? "" : `<div class="fallback">
<p>Obsidian didn't open? Copy this link, then in Obsidian go to <b>Settings → Google Drive Sync → Paste sign-in link</b>.</p>
<input id="link" readonly value="${escapeHtml(target)}" aria-label="Sign-in link">
<button id="copy" type="button">Copy link</button>
</div>`}
<script>
setTimeout(function () { location.href = ${JSON.stringify(target)}; }, 300);
var copy = document.getElementById("copy");
if (copy) copy.addEventListener("click", function () {
  var input = document.getElementById("link");
  input.select();
  var done = function () { copy.textContent = "Copied"; };
  if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand("copy"); done(); });
  else { document.execCommand("copy"); done(); }
});
</script>
</body>
</html>`;
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok");
    if (req.method === "GET" && url.pathname === "/callback") return handleCallback(res, url);
    send(res, 404, "Not found", { "Content-Type": "text/plain" });
  } catch (err) {
    console.error(`${req.method} ${req.url?.split("?")[0]} failed: ${err.message}`);
    if (!res.headersSent) send(res, 500, "server_error", { "Content-Type": "text/plain" });
  }
});

server.listen(PORT, () => console.log(`listening on :${PORT}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
