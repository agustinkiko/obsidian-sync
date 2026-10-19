import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { randomString } from "./auth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime";
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;

export interface RemoteFile {
  id: string;
  name: string;
  md5Checksum: string;
  modifiedTime: string;
}

/** A file found in the vault folder, with its place in the folder tree worked out. */
export interface TreeFile extends RemoteFile {
  /** Vault path, such as `Notes/today.md`. */
  path: string;
  /** Drive folder that holds the file right now. */
  parentId: string;
  /** Uploaded by an older version that stored the full path as the file name, all in one folder. */
  legacy: boolean;
}

interface RawItem {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  modifiedTime: string;
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function multipart(meta: object, data: ArrayBuffer): { body: ArrayBuffer; contentType: string } {
  const boundary = `obsidian-${randomString(12)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.length + data.byteLength + tail.length);
  out.set(head, 0);
  out.set(new Uint8Array(data), head.length);
  out.set(tail, head.length + data.byteLength);
  return { body: out.buffer, contentType: `multipart/related; boundary=${boundary}` };
}

export class Drive {
  constructor(private getToken: () => Promise<string>) {}

  private async call(req: RequestUrlParam): Promise<RequestUrlResponse> {
    const token = await this.getToken();
    const res = await requestUrl({
      ...req,
      headers: { ...req.headers, Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (res.status >= 400) {
      let msg = `${res.status}`;
      try {
        msg = res.json?.error?.message ?? msg;
      } catch {
        // Body was not JSON.
      }
      throw new Error(`Google Drive: ${msg}`);
    }
    return res;
  }

  /** Finds our vault folder, or creates it. */
  async findOrCreateFolder(name: string): Promise<{ id: string; created: boolean }> {
    const q = `mimeType='${FOLDER_MIME}' and name=${quote(name)} and trashed=false`;
    const res = await this.call({ url: `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)` });
    const found = res.json.files?.[0];
    if (found) return { id: found.id, created: false };
    const created = await this.call({
      url: `${API}/files?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    return { id: created.json.id, created: true };
  }

  async folderExists(id: string): Promise<boolean> {
    const token = await this.getToken();
    const res = await requestUrl({
      url: `${API}/files/${id}?fields=id,trashed`,
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    return res.status === 200 && !res.json.trashed;
  }

  /**
   * Lists everything under the vault folder, however deep.
   * With the drive.file scope Drive only shows files this app made, so one paged listing is enough.
   * Each item's vault path is worked out by walking up its parents to the vault folder.
   */
  async listTree(rootId: string): Promise<{ files: TreeFile[]; folders: Map<string, string> }> {
    const fields = "nextPageToken,files(id,name,mimeType,parents,md5Checksum,modifiedTime)";
    const items = new Map<string, RawItem>();
    let pageToken = "";
    do {
      const url =
        `${API}/files?q=${encodeURIComponent("trashed=false")}&fields=${encodeURIComponent(fields)}&pageSize=1000` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await this.call({ url });
      for (const item of (res.json.files ?? []) as RawItem[]) items.set(item.id, item);
      pageToken = res.json.nextPageToken ?? "";
    } while (pageToken);

    // null means "not inside the vault folder" (another vault's folder, or loose in Drive).
    const paths = new Map<string, string | null>();
    const resolve = (id: string): string | null => {
      if (id === rootId) return "";
      if (paths.has(id)) return paths.get(id) ?? null;
      paths.set(id, null); // Stops a loop if Drive ever hands us a cycle.
      const item = items.get(id);
      const parent = item?.parents?.[0];
      let path: string | null = null;
      if (item && parent) {
        const up = resolve(parent);
        if (up !== null) path = up ? `${up}/${item.name}` : item.name;
      }
      paths.set(id, path);
      return path;
    };

    const folders = new Map<string, string>([["", rootId]]);
    const files: TreeFile[] = [];
    for (const item of items.values()) {
      if (item.id === rootId) continue;
      const path = resolve(item.id);
      if (path === null) continue;
      if (item.mimeType === FOLDER_MIME) {
        if (!folders.has(path)) folders.set(path, item.id);
        continue;
      }
      files.push({
        id: item.id,
        name: item.name,
        md5Checksum: item.md5Checksum ?? "",
        modifiedTime: item.modifiedTime,
        path,
        parentId: item.parents?.[0] ?? rootId,
        legacy: item.name.includes("/"),
      });
    }
    return { files, folders };
  }

  /** Returns the Drive folder for a vault folder path, creating any missing levels. */
  async ensureFolderPath(path: string, folders: Map<string, string>): Promise<string> {
    const known = folders.get(path);
    if (known) return known;
    const slash = path.lastIndexOf("/");
    const parentId = await this.ensureFolderPath(slash < 0 ? "" : path.slice(0, slash), folders);
    const res = await this.call({
      url: `${API}/files?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name: path.slice(slash + 1), mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    folders.set(path, res.json.id);
    return res.json.id;
  }

  async download(id: string): Promise<ArrayBuffer> {
    const res = await this.call({ url: `${API}/files/${id}?alt=media` });
    return res.arrayBuffer;
  }

  async create(parentId: string, name: string, data: ArrayBuffer): Promise<RemoteFile> {
    return this.upload("POST", `${UPLOAD}/files`, { name, parents: [parentId] }, data);
  }

  async update(id: string, data: ArrayBuffer): Promise<RemoteFile> {
    return this.upload("PATCH", `${UPLOAD}/files/${id}`, {}, data);
  }

  /** Moves a file into another folder and renames it, without re-uploading it. */
  async move(id: string, name: string, fromParentId: string, toParentId: string): Promise<void> {
    await this.call({
      url:
        `${API}/files/${id}?fields=id&addParents=${encodeURIComponent(toParentId)}` +
        `&removeParents=${encodeURIComponent(fromParentId)}`,
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ name }),
    });
  }

  private async upload(method: "POST" | "PATCH", base: string, meta: object, data: ArrayBuffer): Promise<RemoteFile> {
    if (data.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      const { body, contentType } = multipart(meta, data);
      const res = await this.call({ url: `${base}?uploadType=multipart&fields=${FILE_FIELDS}`, method, contentType, body });
      return res.json;
    }
    // Big file: open an upload session, then send the bytes in one PUT.
    const init = await this.call({
      url: `${base}?uploadType=resumable&fields=${FILE_FIELDS}`,
      method,
      contentType: "application/json; charset=UTF-8",
      headers: { "X-Upload-Content-Type": "application/octet-stream" },
      body: JSON.stringify(meta),
    });
    const location = init.headers["location"] ?? init.headers["Location"];
    if (!location) throw new Error("Google Drive: no upload session URL returned");
    const res = await this.call({ url: location, method: "PUT", contentType: "application/octet-stream", body: data });
    return res.json;
  }

  /** Moves to Drive trash, so it can be recovered for 30 days. */
  async trash(id: string): Promise<void> {
    await this.call({
      url: `${API}/files/${id}`,
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }
}
