# Obsidian Google Drive Sync

Sync your vault to a Google Drive folder. Two parts:

- `plugin/`: the Obsidian plugin (desktop and mobile). It holds your Google client ID and secret and talks to Google directly.
- `server/`: a tiny redirect relay you host on any Kubernetes cluster. It holds no secrets and stores nothing.

Sign-in flow:

```
Obsidian ──opens──> Google sign-in (client ID from the plugin settings)
                       └─> https://<your-relay>/callback        (relay on your cluster)
                             └─> obsidian://gdrive-sync-auth?code=...
Obsidian ──code + client secret──> Google token endpoint ──> tokens stored in Obsidian
```

Files go to a Drive folder named `Obsidian - <vault name>`. Your vault's folders become real Drive folders, so `Notes/today.md` is the file `today.md` inside the folder `Notes`. Files uploaded by older versions (one flat folder, with the full path as the file name) are moved into real folders on the next sync, without re-uploading them.

Throughout this guide, `<your-relay>` is the public hostname you choose for the relay, for example `relay.example.com`.

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
   - Authorized redirect URI: `https://<your-relay>/callback`
   - Copy the **Client ID** and **Client secret**. You will paste them into the Obsidian plugin settings in step 3.
5. When it works, set the app to **In production** (Audience → Publish app). In testing mode, sign-ins expire after 7 days. `drive.file` is a non-sensitive scope, so Google does not require a review.

## 2. Deploy the relay

Choose a hostname (`<your-relay>`) and point it at your cluster's ingress. Google requires HTTPS for the redirect URI, so terminate TLS at your edge (a CDN, tunnel, or cert-manager).

```bash
cd server
kubectl apply -k .
```

This creates a namespace `obsidian-auth` with a Deployment, Service and a standard `Ingress`. The Ingress uses the placeholder host `relay.example.com` and the `traefik` ingress class (the k3s default). Before applying, change them in `server/k8s/ingress.yaml`, or set them in your own overlay so the repo stays untouched. Use `ingressClassName` for your controller if you don't run Traefik.

Check it:

```bash
kubectl -n obsidian-auth get pods
curl https://<your-relay>/healthz
```

The last command should print `ok`.

The relay has no secrets, so there is nothing to create first.

To update the relay later: edit `server/server.js`, then run `kubectl apply -k .` again. The pod restarts by itself.

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

Then in Obsidian:

1. **Settings → Community plugins → enable "Google Drive Sync"**.
2. Open the plugin's settings and fill in:
   - **Relay URL**: `https://<your-relay>`
   - **Google client ID** and **Google client secret** from step 1.
3. Click **Sign in with Google**.

If the browser doesn't switch back to Obsidian after you approve (Chrome often blocks or asks before opening other apps), click **Copy link** on the sign-in page. Then paste it into **Paste sign-in link** in the plugin settings and click **Finish sign-in**.

The client secret is saved in `.obsidian/plugins/gdrive-sync/data.json` inside your vault. Anyone who can read that file can use the secret, so treat the vault folder as sensitive.

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
