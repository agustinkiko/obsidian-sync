import { App, TFile, normalizePath } from "obsidian";
import { Drive, RemoteFile } from "./drive";

/** What a file looked like on both sides after the last good sync. */
export interface FileState {
  mtime: number;
  size: number;
  remoteId: string;
  remoteMd5: string;
}

export type SyncState = Record<string, FileState>;

export interface SyncResult {
  state: SyncState;
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function conflictPath(path: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${base} (conflict ${stamp})${ext}`;
}

export class Syncer {
  constructor(private app: App, private drive: Drive, private folderId: string) {}

  private async ensureParent(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    if (this.app.vault.getAbstractFileByPath(parent)) return;
    await this.ensureParent(parent);
    await this.app.vault.createFolder(parent);
  }

  private async writeLocal(path: string, data: ArrayBuffer): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return existing;
    }
    if (existing) throw new Error(`"${path}" is a folder locally`);
    await this.ensureParent(path);
    return this.app.vault.createBinary(path, data);
  }

  private record(file: TFile, remote: RemoteFile): FileState {
    return { mtime: file.stat.mtime, size: file.stat.size, remoteId: remote.id, remoteMd5: remote.md5Checksum };
  }

  async run(previous: SyncState): Promise<SyncResult> {
    const result: SyncResult = {
      state: {},
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      errors: [],
    };

    const local = new Map<string, TFile>();
    for (const f of this.app.vault.getFiles()) local.set(f.path, f);

    const remote = new Map<string, RemoteFile>();
    for (const r of await this.drive.listFiles(this.folderId)) {
      const path = normalizePath(r.name);
      const seen = remote.get(path);
      // Two devices may have uploaded the same new file at once. Keep the newest.
      if (!seen || r.modifiedTime > seen.modifiedTime) remote.set(path, r);
    }

    // Safety net: if one side is suddenly empty, don't treat it as "everything was deleted".
    // Start fresh instead, which only adds files and never deletes.
    let prev = previous;
    if (Object.keys(prev).length > 0 && (remote.size === 0 || local.size === 0)) prev = {};

    const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(prev)]);
    for (const path of paths) {
      try {
        const state = await this.syncOne(path, local.get(path), remote.get(path), prev[path], result);
        if (state) result.state[path] = state;
      } catch (err) {
        result.errors.push(`${path}: ${(err as Error).message}`);
        // Keep the old state so we retry next time instead of guessing.
        if (prev[path]) result.state[path] = prev[path];
      }
    }
    return result;
  }

  private async syncOne(
    path: string,
    L: TFile | undefined,
    R: RemoteFile | undefined,
    S: FileState | undefined,
    result: SyncResult,
  ): Promise<FileState | undefined> {
    const vault = this.app.vault;

    if (L && R) {
      const localChanged = !S || L.stat.mtime !== S.mtime || L.stat.size !== S.size;
      const remoteChanged = !S || R.md5Checksum !== S.remoteMd5;

      if (S && !localChanged && !remoteChanged) return S;

      if (S && localChanged && !remoteChanged) {
        const up = await this.drive.update(R.id, await vault.readBinary(L));
        result.uploaded++;
        return this.record(L, up);
      }

      if (S && !localChanged && remoteChanged) {
        const file = await this.writeLocal(path, await this.drive.download(R.id));
        result.downloaded++;
        return this.record(file, R);
      }

      // Both changed, or first time we see this file on both sides.
      const localData = await vault.readBinary(L);
      const remoteData = await this.drive.download(R.id);
      if (sameBytes(localData, remoteData)) return this.record(L, R);

      // Real conflict. Newest wins; the other copy is kept next to it so nothing is lost.
      // The conflict copy is a new local file, so the next sync uploads it.
      result.conflicts++;
      const localIsNewer = L.stat.mtime >= Date.parse(R.modifiedTime);
      if (localIsNewer) {
        await this.writeLocal(conflictPath(path), remoteData);
        const up = await this.drive.update(R.id, localData);
        result.uploaded++;
        return this.record(L, up);
      }
      await this.writeLocal(conflictPath(path), localData);
      const file = await this.writeLocal(path, remoteData);
      result.downloaded++;
      return this.record(file, R);
    }

    if (L) {
      if (S) {
        // It was synced before and is now gone from Drive: it was deleted on another device.
        await this.app.fileManager.trashFile(L);
        result.deletedLocal++;
        return undefined;
      }
      const up = await this.drive.create(this.folderId, path, await vault.readBinary(L));
      result.uploaded++;
      return this.record(L, up);
    }

    if (R) {
      if (S) {
        // It was synced before and is now gone locally: it was deleted on this device.
        await this.drive.trash(R.id);
        result.deletedRemote++;
        return undefined;
      }
      const file = await this.writeLocal(path, await this.drive.download(R.id));
      result.downloaded++;
      return this.record(file, R);
    }

    return undefined;
  }
}
