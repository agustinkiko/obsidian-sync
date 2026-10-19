# Obsidian Google Drive Sync

Two parts:

- `plugin/`: the Obsidian plugin (desktop and mobile).
- `server/`: a tiny auth server for your k3s cluster. It holds the Google client secret and stores nothing.

Sign-in flow:

```
Obsidian ──opens──> https://obsidian-sync.jericogustin.com/start
                         └─> Google sign-in
                               └─> https://obsidian-sync.jericogustin.com/callback
                                     └─> obsidian://gdrive-sync-auth?code=...
Obsidian ──POST /token──> server ──> Google ──> tokens back to Obsidian
```

Files go to a Drive folder named `Obsidian - <vault name>`. Each file is stored with its full path as its name, for example `Notes/today.md`.

---

## 1. Google Cloud setup (one time, about 10 minutes)

1. Go to https://console.cloud.google.com/ and create a project.
2. Turn on the Drive API: **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type: **External**.
   - App name, support email, developer email: fill in.
   - Scopes / Data access: add `https://www.googleapis.com/auth/drive.file`.
   - Audience: add your own Google account as a **test user**.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://obsidian-sync.jericogustin.com/callback`
   - Copy the **Client ID** and **Client secret**.
5. When it works, set the app to **In production** (Audience → Publish app). In testing mode, sign-ins expire after 7 days. `drive.file` is a non-sensitive scope, so Google does not require a review.

## 2. Deploy the server on k3s

Point DNS for `obsidian-sync.jericogustin.com` at your k3s server first.

```bash
cd server
cat > secret.env <<'EOF'
CLIENT_ID=paste-client-id-here
CLIENT_SECRET=paste-client-secret-here
EOF
kubectl apply -k .
```

Check it:

```bash
kubectl -n obsidian-auth get pods
curl https://obsidian-sync.jericogustin.com/healthz
```

The last command should print `ok`.

HTTPS: `server/k8s/ingress.yaml` uses cert-manager with a ClusterIssuer named `letsencrypt-prod`. If your issuer has another name, change that line. If you don't use cert-manager, delete the annotation and set up TLS in Traefik your own way. Google requires HTTPS.

To update the server code later: edit `server/server.js`, then run `kubectl apply -k .` again. The pod restarts by itself.

## 3. Build and install the plugin

```bash
cd plugin
npm install
npm run build
```

Copy `main.js` and `manifest.json` into:

```
<your vault>/.obsidian/plugins/gdrive-sync/
```

Then in Obsidian: **Settings → Community plugins → enable "Google Drive Sync"**, then click **Sign in with Google**.

Mobile: put the same two files in the same folder of the vault on your phone. Another way is to publish a GitHub release and install it with the BRAT plugin.

## How sync decides things

| Situation | What happens |
|---|---|
| Changed only on this device | Upload |
| Changed only in Drive | Download |
| Changed on both | Newer one wins. The other is saved as `name (conflict <date>).md` |
| New file on one side | Copied to the other side |
| Deleted on one side (after being synced) | Deleted on the other side (Obsidian trash / Drive trash) |
| One side is suddenly empty | No deletes. Treated as a fresh merge |

The `.obsidian` config folder is not synced.

Sync runs when Obsidian opens, every 5 minutes (you can change this), from the ribbon button, and from the "Sync now" command.
