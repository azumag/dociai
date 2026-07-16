// title/URLの正規化key (issue #189)。
// dedupe判定はすべてここで作るkey同士の比較だけで行い、呼び出し側で生文字列を
// 突き合わせない。

// FNV-1a系のダブルハッシュ。src/readers/reader-runner.js の createReaderItemKey が使う
// hash()と同じ発想 — src/ はBrowserでも動く必要があり、Node専用crypto/非同期
// WebCrypto.subtle.digestを同期keyづくりへ持ち込まないための単純hash。
function hash(value) {
  let left = 0x811c9dc5;
  let right = 0x01000193;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + 0x9e3779b9), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

// source suffixは運用者が知っている自ソースの装飾 (" - Reuters"等) だけを対象にする。
// 汎用heuristicで末尾を盲目的に削ると本文の一部を誤って落とすため、既定は空 (issue本文の
// 「設定可能なpattern」通り、opt-inのみ)。
export function normalizeTitleKey(title, { sourceSuffixPatterns = [], maxLength = 240 } = {}) {
  let value = String(title ?? "").normalize("NFKC");
  for (const pattern of sourceSuffixPatterns) value = value.replace(pattern, "");
  value = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\p{P}\p{S}\s]/gu, "");
  return value.slice(0, maxLength);
}

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "ref", "ref_src", "fbclid", "gclid", "mkt_tok"];

function canonicalizeUrlForHash(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
  parsed.hash = "";
  for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
  parsed.searchParams.sort();
  let out = parsed.toString();
  if (parsed.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

// canonicalUrl (#188がまだなければ item.link) をnormalize/tracking除去後にhash化する。
export function computeUrlHash(url) {
  const canonical = canonicalizeUrlForHash(url);
  return canonical ? hash(canonical) : null;
}
