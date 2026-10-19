import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { randomString } from "./auth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime";
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;

export interface RemoteFile {
  id: string;
  /** The vault path. We store the full path as the Drive file name. */
  name: string;
  md5Checksum: string;
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

  async listFiles(folderId: string): Promise<RemoteFile[]> {
    const q = `${quote(folderId)} in parents and trashed=false and mimeType!='${FOLDER_MIME}'`;
    const fields = "nextPageToken,files(id,name,md5Checksum,modifiedTime)";
    const out: RemoteFile[] = [];
    let pageToken = "";
    do {
      const url =
        `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=1000` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await this.call({ url });
      out.push(...(res.json.files ?? []));
      pageToken = res.json.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async download(id: string): Promise<ArrayBuffer> {
    const res = await this.call({ url: `${API}/files/${id}?alt=media` });
    return res.arrayBuffer;
  }

  async create(folderId: string, path: string, data: ArrayBuffer): Promise<RemoteFile> {
    return this.upload("POST", `${UPLOAD}/files`, { name: path, parents: [folderId] }, data);
  }

  async update(id: string, data: ArrayBuffer): Promise<RemoteFile> {
    return this.upload("PATCH", `${UPLOAD}/files/${id}`, {}, data);
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
