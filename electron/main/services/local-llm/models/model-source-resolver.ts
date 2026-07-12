// Resolves a download job's source into a concrete https URL, and provides the SSRF defenses the
// download service (#76) needs to apply to that URL *and* to every redirect target encountered
// while following it: reject requests to loopback/link-local/private/reserved addresses before a
// socket is ever opened.
//
// Address blocking is deliberately structured as an *injectable policy* (`isPublicAddress` is
// just the default) rather than a hardcoded rule, so tests can point the real downloader at a
// real local HTTP test server on 127.0.0.1 with a permissive policy, while a separate test
// exercises the classifier directly against IP literals (no network) and another confirms the
// *default* policy really does refuse to connect to a real 127.0.0.1 server. See
// scripts/test/local-llm-model-download.test.mjs.
import dns from "node:dns";
import type { LookupAddress, LookupOneOptions, LookupOptions } from "node:dns";
import { ServiceError } from "../../service-error";
import type { DownloadJobSource } from "../../../../shared/local-llm/model-contract";

const SERVICE_ID = "local-llm:source-resolver";

function badSource(message: string): ServiceError {
  return new ServiceError("BAD_REQUEST", message, { serviceId: SERVICE_ID, retryable: false });
}

// Mirrors resources/catalog/local-models.json's `fileName` rule (catalog-loader.ts): a bare file
// name, never a path, so a filename can never be used to smuggle a path-traversal segment into a
// URL. Revision follows the same "no separators" rule; HF revisions are branch names, tags, or
// full commit SHAs, none of which need slashes.
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.gguf$/i;

/** Builds `https://huggingface.co/{repo}/resolve/{revision}/{filename}` — the same URL shape
 * already used by every entry in resources/catalog/local-models.json (see the #75 catalog, and
 * the schema check the #75 test suite runs against it). Never issues a network request itself. */
export function resolveHuggingFaceUrl(source: { repo: string; revision: string; filename: string }): URL {
  if (typeof source.repo !== "string" || !REPO_PATTERN.test(source.repo)) throw badSource('Hugging Face repo must look like "org/name"');
  if (typeof source.revision !== "string" || !REVISION_PATTERN.test(source.revision)) throw badSource("Hugging Face revision is invalid");
  if (typeof source.filename !== "string" || !FILENAME_PATTERN.test(source.filename)) throw badSource("Hugging Face filename must be a bare .gguf file name");
  const [org, name] = source.repo.split("/");
  return new URL(`https://huggingface.co/${encodeURIComponent(org)}/${encodeURIComponent(name)}/resolve/${encodeURIComponent(source.revision)}/${encodeURIComponent(source.filename)}`);
}

/** Resolves any supported DownloadJobSource to its starting https URL. `kind: "url"` covers
 * catalog entries (whose `source.url` is already a fully-formed https download URL, see
 * catalog-loader.ts's `assertSource`) as well as any other pre-resolved https source.
 *
 * `allowInsecure` exists solely so tests can point a `kind: "url"` source at a real local plain-
 * HTTP mock server (see scripts/test/local-llm-model-download.test.mjs) instead of standing up a
 * self-signed TLS server — it is never set by the shipped default construction of
 * ModelDownloadService (electron/main/index.ts), so production traffic is always https-only. */
export function resolveDownloadSourceUrl(source: DownloadJobSource, options: { allowInsecure?: boolean } = {}): URL {
  if (source.kind === "huggingface") return resolveHuggingFaceUrl(source);
  if (source.kind === "url") {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw badSource("download URL is invalid");
    }
    const httpsOk = url.protocol === "https:";
    const insecureOk = options.allowInsecure === true && url.protocol === "http:";
    if (!httpsOk && !insecureOk) throw badSource("download URL must use https");
    if (url.username || url.password) throw badSource("download URL must not embed credentials");
    return url;
  }
  throw badSource("unknown download source kind");
}

export type AddressClass = "loopback" | "link-local" | "private" | "unique-local" | "reserved" | "multicast" | "unspecified" | "public";

function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error(`invalid IPv4 address: ${ip}`);
  const [a, b] = parts;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // includes the 169.254.169.254 cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return "private"; // RFC 6598 carrier-grade NAT shared space
  if (a >= 224 && a <= 239) return "multicast";
  if (parts.every((part) => part === 255)) return "reserved";
  return "public";
}

function classifyIPv6(ip: string): AddressClass {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "unspecified";
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return classifyIPv4(mapped);
  }
  const firstGroup = normalized.split(":")[0];
  const value = firstGroup ? parseInt(firstGroup, 16) : NaN;
  if (Number.isFinite(value)) {
    if (value >= 0xfe80 && value <= 0xfebf) return "link-local"; // fe80::/10
    if (value >= 0xfc00 && value <= 0xfdff) return "unique-local"; // fc00::/7 (RFC 4193)
    if (value >= 0xff00 && value <= 0xffff) return "multicast";
  }
  return "public";
}

/** Intentionally not a full IP-address library: just enough classification to drive an
 * allow/deny decision for outbound download connections (SSRF defense against a
 * malicious/compromised catalog entry or redirect target). */
export function classifyIpAddress(address: string, family?: 4 | 6): AddressClass {
  const resolvedFamily = family ?? (address.includes(":") ? 6 : 4);
  return resolvedFamily === 6 ? classifyIPv6(address) : classifyIPv4(address);
}

export type AddressPolicy = (address: string, family: 4 | 6) => boolean;

/** Default, shipped policy: only a "public" address may be connected to. */
export const isPublicAddress: AddressPolicy = (address, family) => classifyIpAddress(address, family) === "public";

type DnsLookupOneCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
export type DnsLookupOne = (hostname: string, options: LookupOneOptions, callback: DnsLookupOneCallback) => void;
export type GuardedLookupFunction = (hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => void;

/** Builds a drop-in replacement for the `lookup` option accepted by `http.request`/
 * `https.request`. Node calls this instead of connecting directly, and uses *exactly the address
 * this function hands back* to open the socket — so gating the decision here (rather than
 * resolving-then-separately-checking-then-connecting) closes the DNS-rebinding TOCTOU window a
 * "resolve, check, connect" sequence would otherwise leave open.
 *
 * IMPORTANT: Node only invokes a custom `lookup` for hostnames it actually has to *resolve* — a
 * URL whose host is already a literal IP address (e.g. `http://127.0.0.1/...`, arguably the most
 * common real SSRF payload) connects directly and never calls this function at all. Callers MUST
 * separately classify a literal-IP host (`net.isIP(hostname)`) and reject it before even reaching
 * here; model-download-service.ts's #singleRequest does exactly that. This function alone only
 * covers the "hostname resolves to a private address" case. */
export function createGuardedLookup(isAllowed: AddressPolicy = isPublicAddress, dnsLookup: DnsLookupOne = dns.lookup as unknown as DnsLookupOne): GuardedLookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family ?? 0, hints: options.hints, all: false }, (err, address, family) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const resolvedFamily = (family === 6 ? 6 : 4) as 4 | 6;
      if (!isAllowed(address, resolvedFamily)) {
        const blocked = Object.assign(new Error(`refusing to connect to a disallowed address (${address})`), { code: "EADDRBLOCKED" });
        callback(blocked, "", 0);
        return;
      }
      callback(null, address, family);
    });
  };
}
