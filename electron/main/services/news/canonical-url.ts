// canonical URL解決 (issue #188)。優先順位:
//   1. <link rel="canonical"> / <meta property="og:url">
//   2. 無ければredirect後の最終URL (呼び出し側がSafeHttpClientの応答urlをfallbackUrlに渡す)
// Google Newsのredirect URLは、SafeHttpClient自体がredirectを辿って最終publisher URLを
// 返すため、専用resolverを別に持たず「fallbackUrlとして最終urlを渡す」だけで解決できる。

const CANONICAL_LINK_PATTERNS = [
  /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
  /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i,
];

const OG_URL_PATTERNS = [
  /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["'][^>]*>/i,
];

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function extractCanonicalUrl(html: string, fallbackUrl: string): string {
  const candidate = firstMatch(html, CANONICAL_LINK_PATTERNS) ?? firstMatch(html, OG_URL_PATTERNS);
  if (!candidate) return fallbackUrl;
  try {
    return new URL(decodeHtmlAttribute(candidate), fallbackUrl).toString();
  } catch {
    return fallbackUrl;
  }
}
