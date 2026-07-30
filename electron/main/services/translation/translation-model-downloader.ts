// 翻訳モデルファイルの検証付きダウンロード (issue #257 Phase 3, #262)。
// electron/main/services/local-llm/models/model-download-service.tsのSSRF防御
// (isPublicAddress, 文字列IPリテラルの事前拒否) は再利用しつつ、job-store・レジューム
// (Range再開)は持たない縮小版: 翻訳モデルの導入は稀な一回限りの操作であり、中断時は
// 「最初からやり直す」retryで十分と判断した (バイト単位のレジュームはPhase 3の対象外、
// 将来の改善余地として残す)。
//
// createGuardedLookup (同じmodel-source-resolver.ts) は再利用していない: 実ホスト名
// (huggingface.co等) に対して実際に検証した際、`ERR_INVALID_IP_ADDRESS: Invalid IP address:
// undefined` で例外になることを確認した。原因はNodeのhttp/https clientがカスタムlookupを
// `{ all: true }` (Happy Eyeballs、複数アドレスを配列で要求) で呼ぶ場合があるのに対し、
// createGuardedLookupは`all: false`固定でdns.lookupへ委譲しており、要求された配列形状ではなく
// 単一(address, family)を返してしまうため。ローカルfixtureサーバ・IPリテラル直指定のテストだけでは
// この経路(実ホスト名解決)を通らないため、既存のtest群でも顕在化していなかったと見られる
// (electron/main/services/local-llm/models/model-source-resolver.tsは変更せず、ここでは
// options.allを正しく尊重する独自版を実装する)。
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import dns from "node:dns";
import { ServiceError, errorFromHttpStatus } from "../service-error";
import { isPublicAddress } from "../local-llm/models/model-source-resolver";
import type { AddressPolicy, DnsLookupOne } from "../local-llm/models/model-source-resolver";

type LookupResultEntry = { address: string; family: number };
type GuardedLookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupResultEntry[], family?: number) => void;

/** Drop-in replacement for the `lookup` option accepted by `http.request`/`https.request`, correct
 * for BOTH calling conventions Node actually uses: a single `(address, family)` pair, or (when
 * Happy-Eyeballs dual-stack connection racing is in play) `options.all === true` requesting every
 * resolved address as an array. Always resolves via `dns.lookup(..., { all: true })` internally so
 * every candidate address can be filtered against `isAllowed` before any of them are handed back —
 * closing the same DNS-rebinding TOCTOU window createGuardedLookup's own header comment describes. */
export function guardedLookup(isAllowed: AddressPolicy, dnsLookup: DnsLookupOne): (hostname: string, options: { family?: number; hints?: number; all?: boolean }, callback: GuardedLookupCallback) => void {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family ?? 0, hints: options.hints, all: true } as never, ((err: NodeJS.ErrnoException | null, addresses: unknown) => {
      if (err) { callback(err); return; }
      const resolved: LookupResultEntry[] = Array.isArray(addresses)
        ? (addresses as LookupResultEntry[])
        : [{ address: addresses as unknown as string, family: net.isIP(String(addresses)) || 4 }];
      const allowed = resolved.filter((entry) => isAllowed(entry.address, (entry.family === 6 ? 6 : 4)));
      if (allowed.length === 0) {
        callback(Object.assign(new Error(`refusing to connect to a disallowed address (${resolved.map((entry) => entry.address).join(", ") || "no address"})`), { code: "EADDRBLOCKED" }));
        return;
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0].address, allowed[0].family);
    }) as never);
  };
}

const SERVICE_ID = "translation:downloader";
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export type DownloadFileInput = {
  url: URL;
  destinationPath: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
  isAddressAllowed?: AddressPolicy;
  dnsLookup?: DnsLookupOne;
  httpsRequest?: typeof https.request;
  httpRequest?: typeof http.request;
  maxRedirects?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Test-only escape hatch (mirrors model-download-service.ts's own `allowInsecure` option): lets
   * a test point this at a real local http:// fixture server instead of standing up a self-signed
   * TLS server. Never set by production code — TranslationModelRepository never passes this. */
  allowInsecure?: boolean;
};

function mapStreamError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
    return new ServiceError("CANCELLED", "download cancelled", { serviceId: SERVICE_ID, retryable: false });
  }
  return new ServiceError("NETWORK", error instanceof Error ? error.message : "download failed", { serviceId: SERVICE_ID, retryable: true });
}

type RequestFn = (url: URL, options: Record<string, unknown>, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;

function singleRequest(url: URL, options: Required<Pick<DownloadFileInput, "isAddressAllowed" | "connectTimeoutMs">> & { httpsRequest: typeof https.request; httpRequest: typeof http.request; dnsLookup: DnsLookupOne }, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // 文字列IPリテラルはNodeのカスタムlookupを一切経由しないため、ソケットを開く前にここで判定する。
    const literalHost = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = net.isIP(literalHost);
    if (literalFamily !== 0 && !options.isAddressAllowed(literalHost, literalFamily as 4 | 6)) {
      reject(new ServiceError("BAD_REQUEST", `refusing to connect to a disallowed address (${literalHost})`, { serviceId: SERVICE_ID, retryable: false }));
      return;
    }
    const transport = (url.protocol === "https:" ? options.httpsRequest : options.httpRequest) as unknown as RequestFn;
    const lookup = guardedLookup(options.isAddressAllowed, options.dnsLookup);
    const request = transport(url, { method: "GET", headers: { "User-Agent": "dociai-translation/1", Accept: "*/*" }, lookup, timeout: options.connectTimeoutMs, signal }, (response) => resolve(response));
    request.on("timeout", () => request.destroy(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (error) => reject(mapStreamError(error)));
    request.end();
  });
}

/** https-only, bounded-redirect, SSRF-guarded download of a single file to `destinationPath`,
 * hashing the stream incrementally and verifying both size and sha256 once fully written. Throws
 * (and leaves no file behind) on any mismatch — callers must not treat a thrown call as "partially
 * downloaded, safe to resume"; the caller should discard `destinationPath` and retry from scratch. */
export async function downloadVerifiedFile(input: DownloadFileInput): Promise<{ sha256: string; sizeBytes: number }> {
  const isAddressAllowed = input.isAddressAllowed ?? isPublicAddress;
  const dnsLookup = input.dnsLookup ?? (dns.lookup as unknown as DnsLookupOne);
  const httpsRequest = input.httpsRequest ?? https.request;
  const httpRequest = input.httpRequest ?? http.request;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  await fsp.mkdir(path.dirname(input.destinationPath), { recursive: true, mode: 0o700 });
  await fsp.rm(input.destinationPath, { force: true }).catch(() => {});

  let currentUrl = input.url;
  const insecureOk = input.allowInsecure === true && currentUrl.protocol === "http:";
  if (currentUrl.protocol !== "https:" && !insecureOk) throw new ServiceError("BAD_REQUEST", "download URL must use https", { serviceId: SERVICE_ID, retryable: false });
  let redirectCount = 0;
  let response: http.IncomingMessage;
  for (;;) {
    if (input.signal.aborted) throw new ServiceError("CANCELLED", "download cancelled", { serviceId: SERVICE_ID, retryable: false });
    response = await singleRequest(currentUrl, { isAddressAllowed, connectTimeoutMs, httpsRequest, httpRequest, dnsLookup }, input.signal);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      redirectCount += 1;
      if (redirectCount > maxRedirects) throw new ServiceError("BAD_REQUEST", "too many redirects", { serviceId: SERVICE_ID, retryable: false });
      const nextUrl = new URL(response.headers.location, currentUrl);
      if (nextUrl.protocol !== "https:" && !(insecureOk && nextUrl.protocol === "http:")) throw new ServiceError("BAD_REQUEST", "refusing to follow a redirect away from https", { serviceId: SERVICE_ID, retryable: false });
      currentUrl = nextUrl;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw errorFromHttpStatus(status, { serviceId: SERVICE_ID });
    }
    break;
  }

  const hash = crypto.createHash("sha256");
  let bytesDownloaded = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    const writeStream = fs.createWriteStream(input.destinationPath, { flags: "w" });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => response.destroy(new Error("stalled: no data received within the idle timeout")), idleTimeoutMs);
    };
    const onAbort = () => response.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    input.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { if (idleTimer) clearTimeout(idleTimer); input.signal.removeEventListener("abort", onAbort); };

    resetIdleTimer();
    response.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      bytesDownloaded += chunk.length;
      if (bytesDownloaded > input.expectedSizeBytes) {
        cleanup();
        response.destroy();
        writeStream.destroy();
        settle(() => reject(new ServiceError("BAD_REQUEST", `downloaded content exceeds the expected size (${input.expectedSizeBytes} bytes)`, { serviceId: SERVICE_ID, retryable: false })));
        return;
      }
      hash.update(chunk);
      input.onProgress?.(bytesDownloaded, input.expectedSizeBytes);
      if (!writeStream.write(chunk)) response.pause();
    });
    writeStream.on("drain", () => response.resume());
    response.on("error", (error) => { cleanup(); writeStream.destroy(); settle(() => reject(mapStreamError(error))); });
    writeStream.on("error", (error) => { cleanup(); response.destroy(); settle(() => reject(mapStreamError(error))); });
    let endedNormally = false;
    response.on("close", () => {
      if (endedNormally) return;
      cleanup();
      writeStream.destroy();
      settle(() => reject(new ServiceError("NETWORK", "connection closed before the download finished", { serviceId: SERVICE_ID, retryable: true })));
    });
    response.on("end", () => {
      endedNormally = true;
      cleanup();
      writeStream.end(() => settle(() => resolve()));
    });
  });

  if (bytesDownloaded !== input.expectedSizeBytes) {
    await fsp.rm(input.destinationPath, { force: true }).catch(() => {});
    throw new ServiceError("NETWORK", `downloaded ${bytesDownloaded} bytes, expected ${input.expectedSizeBytes}`, { serviceId: SERVICE_ID, retryable: true });
  }
  const sha256 = hash.digest("hex");
  if (sha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
    await fsp.rm(input.destinationPath, { force: true }).catch(() => {});
    throw new ServiceError("BAD_REQUEST", `sha256 mismatch: expected ${input.expectedSha256}, got ${sha256}`, { serviceId: SERVICE_ID, retryable: true });
  }
  return { sha256, sizeBytes: bytesDownloaded };
}
