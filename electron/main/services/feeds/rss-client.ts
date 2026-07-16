import { lookup } from "node:dns/promises";
import { ServiceError, errorFromHttpStatus } from "../service-error";

export type SafeHttpResponse = { url: string; status: number; headers: Headers; body: string };
type Resolver = (host: string) => Promise<string[]>;
// issue #188: allowedHosts (source単位のhost allowlist) を追加。redirect各hopで
// isPrivateAddressと同じloopで再検査するため、初期URLだけでなくredirect先にも及ぶ。
type SafeHttpOptions = { method?: "GET" | "POST"; headers?: Record<string, string>; signal: AbortSignal; maxBytes?: number; acceptedContentTypes: string[]; maxRedirects?: number; allowedHosts?: string[] };

function isPrivateAddress(address: string): boolean {
  // ::ffff:a.b.c.d (IPv4-mapped IPv6) はdotted-quad部分だけを見て同じIPv4判定にかける。
  // これを剥がさないと、悪意あるDNS応答がmapped形式でloopback/metadataアドレスを返した
  // ときにprivate判定をすり抜けてしまう。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address.trim());
  const normalized = (mapped ? mapped[1] : address).toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:" ) || normalized === "0.0.0.0") return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  // 169.254.0.0/16 はリンクローカル (169.254.169.254のクラウドmetadataエンドポイントを含む)。
  // 100.64.0.0/10 はCGNAT (RFC 6598) — キャリア内部網でprivateと同様に扱う。
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isAllowedHost(hostname: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts?.length) return true;
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((allowed) => normalized === allowed.toLowerCase() || normalized.endsWith(`.${allowed.toLowerCase()}`));
}

async function defaultResolver(host: string): Promise<string[]> { return (await lookup(host, { all: true })).map((entry) => entry.address); }

async function readLimited(response: Response, maxBytes: number, signal: AbortSignal, serviceId: string): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new ServiceError("BAD_REQUEST", "response body is too large", { serviceId, retryable: false });
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof ServiceError ? signal.reason : new ServiceError("CANCELLED", "request cancelled", { serviceId, retryable: false });
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new ServiceError("BAD_REQUEST", "response body is too large", { serviceId, retryable: false });
        chunks.push(value);
      }
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export class SafeHttpClient {
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly resolveHost: Resolver = defaultResolver) {}

  async request(rawUrl: string, options: SafeHttpOptions): Promise<SafeHttpResponse> {
    const maxBytes = options.maxBytes ?? 1_000_000;
    const maxRedirects = options.maxRedirects ?? 3;
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ServiceError("BAD_REQUEST", "source URL is invalid", { serviceId: "http", retryable: false }); }
    const initialWasHttps = url.protocol === "https:";
    let headers = { ...(options.headers ?? {}) };
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ServiceError("BAD_REQUEST", "source URL is not allowed", { serviceId: "http", retryable: false });
      // 侵害された/中間者の redirect先がhttpへ格下げしてTLS保護を外すのを防ぐ。
      if (initialWasHttps && url.protocol !== "https:") throw new ServiceError("BAD_REQUEST", "source redirect downgraded from https to http", { serviceId: "http", retryable: false });
      if (!isAllowedHost(url.hostname, options.allowedHosts)) throw new ServiceError("BAD_REQUEST", "source URL host is not allowed", { serviceId: "http", retryable: false });
      const addresses = await this.resolveHost(url.hostname);
      if (!addresses.length || addresses.some(isPrivateAddress)) throw new ServiceError("BAD_REQUEST", "source URL resolves to a private address", { serviceId: "http", retryable: false });
      let response: Response;
      try { response = await this.fetchFn(url.toString(), { method: options.method ?? "GET", headers, signal: options.signal, redirect: "manual" }); }
      catch (error) {
        if (options.signal.aborted) throw options.signal.reason instanceof ServiceError ? options.signal.reason : new ServiceError("CANCELLED", "request cancelled", { serviceId: "http", retryable: false });
        throw new ServiceError("NETWORK", "source connection failed", { serviceId: "http" });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === maxRedirects) throw new ServiceError("BAD_REQUEST", "source redirect is invalid", { serviceId: "http", retryable: false });
        const next = new URL(location, url);
        if (next.host !== url.host) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "authorization"));
        url = next;
        continue;
      }
      if (!response.ok) throw errorFromHttpStatus(response.status, { serviceId: "http", retryAfterMs: (() => { const seconds = Number(response.headers.get("retry-after")); return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined; })() });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!options.acceptedContentTypes.some((allowed) => contentType.includes(allowed))) throw new ServiceError("BAD_REQUEST", "source content type is not allowed", { serviceId: "http", retryable: false });
      return { url: url.toString(), status: response.status, headers: response.headers, body: await readLimited(response, maxBytes, options.signal, "http") };
    }
    throw new ServiceError("BAD_REQUEST", "source redirect is invalid", { serviceId: "http", retryable: false });
  }
}
