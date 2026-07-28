import crypto from "node:crypto";
import type { OverlayAssetService } from "./overlay-asset-service";

const HANDLE_TTL_MS = 60 * 60 * 1000;
const MAX_HANDLES = 1_000;
type HandleEntry = { assetId: string; expiresAt: number };

export class OverlayAssetUrlResolver {
  #handles = new Map<string, HandleEntry>();
  constructor(private readonly service: OverlayAssetService, private readonly clock: () => number = Date.now) {}

  async issue(assetId: string): Promise<{ handle: string; mimeType: string }> {
    const resolved = await this.service.openPlayback(assetId); await resolved.handle.close();
    this.#prune();
    while (this.#handles.size >= MAX_HANDLES) this.#handles.delete(this.#handles.keys().next().value as string);
    const token = crypto.randomBytes(32).toString("base64url");
    this.#handles.set(token, { assetId, expiresAt: this.clock() + HANDLE_TTL_MS });
    return { handle: `dociai-asset://asset/${token}`, mimeType: resolved.record.mimeType };
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response("Not found", { status: 404 }); }
    const token = url.pathname.slice(1);
    if (url.hostname !== "asset" || url.username || url.password || url.port || url.pathname !== `/${token}` || !/^[A-Za-z0-9_-]{43}$/.test(token) || url.search || url.hash) return new Response("Not found", { status: 404 });
    const handle = this.#handles.get(token);
    if (!handle || handle.expiresAt <= this.clock()) { this.#handles.delete(token); return new Response("Not found", { status: 404 }); }
    let opened: Awaited<ReturnType<OverlayAssetService["openPlayback"]>> | null = null;
    try {
      opened = await this.service.openPlayback(handle.assetId); const { record } = opened; const size = opened.size;
      const common = { "Content-Type": record.mimeType, "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...common, "Content-Length": String(size) } });
      const range = request.headers.get("range");
      if (!range) { const body = Buffer.alloc(size); await opened.handle.read(body, 0, size, 0); return new Response(body, { status: 200, headers: { ...common, "Content-Length": String(size) } }); }
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response("Range not satisfiable", { status: 416, headers: { ...common, "Content-Range": `bytes */${size}` } });
      let start = match[1] ? Number(match[1]) : 0; let end = match[2] ? Number(match[2]) : size - 1;
      if (!match[1] && match[2]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return new Response("Range not satisfiable", { status: 416, headers: { ...common, "Content-Range": `bytes */${size}` } });
      end = Math.min(end, size - 1); const body = Buffer.alloc(end - start + 1); await opened.handle.read(body, 0, body.length, start);
      return new Response(body, { status: 206, headers: { ...common, "Content-Length": String(body.length), "Content-Range": `bytes ${start}-${end}/${size}` } });
    } catch { return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } }); }
    finally { await opened?.handle.close().catch(() => {}); }
  }

  clear(): void { this.#handles.clear(); }
  #prune(): void { const now = this.clock(); for (const [token, entry] of this.#handles) if (entry.expiresAt <= now) this.#handles.delete(token); }
}
