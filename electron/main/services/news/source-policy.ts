// source policy (issue #188): sourceのarticleFetch設定 (never/auto/required) からarticle
// fetchを行うかどうかを決める。host allowlistの事前検査 (SafeHttpClient自身もredirect各hopで
// 同じ検査をするため、ここでの事前検査は「明らかに許可されないURLへの接続試行を避ける」
// 早期return用)。

export function isHostAllowed(url: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts?.length) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => hostname === allowed.toLowerCase() || hostname.endsWith(`.${allowed.toLowerCase()}`));
}

export type ArticleFetchMode = "never" | "auto" | "required";

// feed内本文 (content:encoded/description等) が十分な長さを持つ場合、autoモードでは
// article fetchを省略する (issue #188「十分な本文がfeed内にある場合はarticle fetchを省略」)。
export function shouldFetchArticle(mode: ArticleFetchMode | undefined, hasSufficientFeedContent: boolean): boolean {
  const resolved = mode ?? "auto";
  if (resolved === "never") return false;
  if (resolved === "required") return true;
  return !hasSufficientFeedContent;
}
