import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  PROTOCOL_ACTION,
  OAuthClient,
  PendingLogin,
  createLogin,
  exchangeCode,
  parseSignInLink,
  refreshAccessToken,
  revoke,
} from "./auth";
import { Drive } from "./drive";
import { SyncState, Syncer } from "./sync";

// Where you deployed the relay (serves /callback), e.g. https://relay.example.com.
// No default: each user sets their own in the settings. Google itself is called directly from the plugin.
const DEFAULT_SERVER_URL = "";

interface Settings {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  pendingLogin: PendingLogin | null;
  folderId: string;
  autoSyncMinutes: number;
  lastSync: number;
  syncState: SyncState;
  lastSignInNote: string;
}

const DEFAULTS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  pendingLogin: null,
  folderId: "",
  autoSyncMinutes: 5,
  lastSync: 0,
  syncState: {},
  lastSignInNote: "",
};

export default class GDriveSyncPlugin extends Plugin {
  settings!: Settings;
  private accessToken = "";
  private accessTokenExpiresAt = 0;
  private syncing = false;
  private timer: number | null = null;
  private statusEl!: HTMLElement;
  private settingTab!: GDriveSettingTab;
  drive!: Drive;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.drive = new Drive(() => this.getAccessToken());

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => this.finishLogin(params));

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => this.sync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync() });
    this.addCommand({ id: "sign-in", name: "Sign in with Google", callback: () => this.startLogin() });

    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    this.settingTab = new GDriveSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.resetTimer();
    this.app.workspace.onLayoutReady(() => {
      if (this.isSignedIn()) this.sync();
    });
  }

  onunload() {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Saves a short sign-in status in data.json. Never store codes, states or secrets here. */
  async noteSignIn(note: string) {
    this.settings.lastSignInNote = `${new Date().toISOString()} ${note}`;
    await this.saveSettings();
  }

  isSignedIn(): boolean {
    return !!this.settings.refreshToken;
  }

  private serverUrl(): string {
    return this.settings.serverUrl.replace(/\/+$/, "");
  }

  private oauthClient(): OAuthClient {
    return {
      clientId: this.settings.clientId.trim(),
      clientSecret: this.settings.clientSecret.trim(),
      redirectUri: `${this.serverUrl()}/callback`,
    };
  }

  resetTimer() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.timer = window.setInterval(() => {
        if (this.isSignedIn()) this.sync(true);
      }, minutes * 60 * 1000);
      this.registerInterval(this.timer);
    }
  }

  updateStatus(text?: string) {
    if (text) {
      this.statusEl.setText(text);
      return;
    }
    if (!this.isSignedIn()) {
      this.statusEl.setText("Drive: signed out");
    } else if (this.settings.lastSync) {
      const time = new Date(this.settings.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.statusEl.setText(`Drive: synced ${time}`);
    } else {
      this.statusEl.setText("Drive: ready");
    }
  }

  // ---------- Sign in ----------

  async startLogin() {
    if (!this.serverUrl() || !this.settings.clientId.trim() || !this.settings.clientSecret.trim()) {
      new Notice("Enter your relay URL, Google client ID and client secret in the settings first.");
      return;
    }
    const { url, pending } = await createLogin(this.oauthClient());
    this.settings.pendingLogin = pending;
    await this.saveSettings();
    await this.noteSignIn("sign-in started, browser opened");
    window.open(url);
  }

  /** Fallback for browsers that don't hand the obsidian:// link to Obsidian. */
  async finishLoginFromLink(link: string) {
    const params = parseSignInLink(link);
    if (!params) {
      new Notice("That doesn't look like a sign-in link. Copy it from the sign-in page and try again.");
      return;
    }
    await this.finishLogin(params);
  }

  private async finishLogin(params: Record<string, string>) {
    const pending = this.settings.pendingLogin;
    // Diagnostics only: never log the code or the state values themselves.
    console.debug("[gdrive-sync] sign-in callback", {
      hasCode: !!params.code,
      hasState: !!params.state,
      error: params.error ?? null,
      hasPendingLogin: !!pending,
      stateMatches: !!pending && params.state === pending.state,
    });
    await this.noteSignIn(
      `callback received: code=${!!params.code}, state=${!!params.state}, error=${params.error ?? "none"}, ` +
        `pending=${!!pending}, stateMatches=${!!pending && params.state === pending.state}`,
    );
    if (params.error) {
      new Notice(`Google sign-in failed: ${params.error}`);
      return;
    }
    if (!pending || params.state !== pending.state || !params.code) {
      new Notice("Google sign-in link was not valid. Please try again.");
      return;
    }
    try {
      const tokens = await exchangeCode(this.oauthClient(), params.code, pending.verifier);
      if (!tokens.refreshToken) throw new Error("Google did not return a refresh token");
      this.settings.refreshToken = tokens.refreshToken;
      this.settings.pendingLogin = null;
      this.accessToken = tokens.accessToken;
      this.accessTokenExpiresAt = tokens.expiresAt;
      await this.saveSettings();
      new Notice("Signed in to Google Drive.");
      this.settingTab.display();
      this.updateStatus();
      this.sync();
    } catch (err) {
      console.error("[gdrive-sync] sign-in failed:", (err as Error).message);
      await this.noteSignIn(`token exchange failed: ${(err as Error).message}`);
      new Notice(`Google sign-in failed: ${(err as Error).message}`);
    }
  }

  async signOut() {
    const token = this.settings.refreshToken;
    this.settings.refreshToken = "";
    this.settings.folderId = "";
    this.settings.syncState = {};
    this.settings.lastSync = 0;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    await this.saveSettings();
    if (token) await revoke(token).catch(() => undefined);
    this.updateStatus();
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    if (!this.settings.refreshToken) throw new Error("Not signed in");
    const tokens = await refreshAccessToken(this.oauthClient(), this.settings.refreshToken);
    this.accessToken = tokens.accessToken;
    this.accessTokenExpiresAt = tokens.expiresAt;
    return this.accessToken;
  }

  // ---------- Sync ----------

  private folderName(): string {
    return `Obsidian - ${this.app.vault.getName()}`;
  }

  async sync(quiet = false) {
    if (!this.isSignedIn()) {
      new Notice("Sign in with Google first (Settings → Google Drive Sync).");
      return;
    }
    if (this.syncing) return;
    this.syncing = true;
    this.updateStatus("Drive: syncing…");
    try {
      // If the Drive folder is gone (or this is the first run), find or create it and start fresh.
      if (!this.settings.folderId || !(await this.drive.folderExists(this.settings.folderId))) {
        const { id } = await this.drive.findOrCreateFolder(this.folderName());
        this.settings.folderId = id;
        this.settings.syncState = {};
      }

      const result = await new Syncer(this.app, this.drive, this.settings.folderId).run(this.settings.syncState);
      this.settings.syncState = result.state;
      this.settings.lastSync = Date.now();
      await this.saveSettings();

      const changes =
        result.uploaded +
        result.downloaded +
        result.deletedLocal +
        result.deletedRemote +
        result.conflicts +
        result.moved;
      if (result.errors.length) {
        console.error("[gdrive-sync] errors:", result.errors);
        new Notice(`Drive sync finished with ${result.errors.length} error(s). See the developer console.`);
      } else if (!quiet || changes > 0) {
        const parts = [
          result.uploaded && `${result.uploaded} up`,
          result.downloaded && `${result.downloaded} down`,
          result.deletedLocal + result.deletedRemote && `${result.deletedLocal + result.deletedRemote} deleted`,
          result.conflicts && `${result.conflicts} conflict(s) kept as copies`,
          result.moved && `${result.moved} moved into Drive folders`,
        ].filter(Boolean);
        new Notice(`Drive sync done${parts.length ? `: ${parts.join(", ")}` : ""}.`);
      }
    } catch (err) {
      console.error("[gdrive-sync]", err);
      new Notice(`Drive sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }
}

class GDriveSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GDriveSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (this.plugin.isSignedIn()) {
      new Setting(containerEl)
        .setName("Google account")
        .setDesc("Signed in. Files sync to the Drive folder \"Obsidian - <vault name>\".")
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(async () => {
            await this.plugin.signOut();
            this.display();
          }),
        );
      new Setting(containerEl)
        .setName("Sync now")
        .addButton((b) => b.setButtonText("Sync").setCta().onClick(() => this.plugin.sync()));
    } else {
      new Setting(containerEl)
        .setName("Google account")
        .setDesc("Sign in to start syncing. A browser opens; after you approve, it sends you back here.")
        .addButton((b) => b.setButtonText("Sign in with Google").setCta().onClick(() => this.plugin.startLogin()));

      let link = "";
      new Setting(containerEl)
        .setName("Paste sign-in link")
        .setDesc("If the browser didn't bring you back here, copy the link from the sign-in page and paste it here.")
        .addText((t) => t.setPlaceholder("obsidian://gdrive-sync-auth?code=…").onChange((v) => (link = v)))
        .addButton((b) => b.setButtonText("Finish sign-in").onClick(() => this.plugin.finishLoginFromLink(link)));
    }

    new Setting(containerEl)
      .setName("Auto-sync every (minutes)")
      .setDesc("0 turns auto-sync off.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.autoSyncMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return;
          this.plugin.settings.autoSyncMinutes = n;
          await this.plugin.saveSettings();
          this.plugin.resetTimer();
        }),
      );

    new Setting(containerEl)
      .setName("Google client ID")
      .setDesc("From your Google Cloud OAuth client (Web application).")
      .addText((t) =>
        t
          .setPlaceholder("xxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (v) => {
            this.plugin.settings.clientId = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Google client secret")
      .setDesc("Saved in this vault's plugin data file (.obsidian/plugins/gdrive-sync/data.json).")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
          this.plugin.settings.clientSecret = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Relay URL")
      .setDesc("Where you deployed the relay (it serves /callback), e.g. https://relay.example.com.")
      .addText((t) =>
        t.setPlaceholder("https://relay.example.com").setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }),
      );
  }
}
