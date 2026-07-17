// NewsAttribution構築 (issue #193)。research bundleのsource + candidateのlicense情報から、
// 音声本文へURLを読ませない代わりに別途operator/OBSへ示すための出典一覧を作る。
// research bundleが無い/sourceが無い場合はcandidate自身 (記事取得元) を単一sourceとして使う。

function toAttribution(entry, fallbackLicense) {
  const license = entry?.license ?? fallbackLicense ?? null;
  return {
    sourceName: entry?.sourceName || "",
    url: entry?.url ?? null,
    author: entry?.author ?? null,
    licenseName: license?.name ?? null,
    licenseUrl: license?.url ?? null,
    attributionRequired: Boolean(license?.attributionRequired),
  };
}

export function buildAttributions(researchBundle, candidate = {}) {
  const sources = researchBundle?.sources ?? [];
  // candidate.licenseはcandidate自身の取得元にのみ適用されるfallbackであり、research
  // bundleの (candidateとは無関係な) 各sourceへ持ち込んではいけない — 持ち込むと
  // 無関係な third-party source がcandidateのlicenseを騙ることになる。
  if (sources.length) return sources.map((source) => toAttribution(source, null));

  const url = candidate.canonicalUrl ?? candidate.link ?? null;
  if (!url && !candidate.sourceName) return [];
  return [toAttribution({ sourceName: candidate.sourceName, url }, candidate.license)];
}

// attribution requiredなsourceのうち、operatorへ表示するための最低限の情報 (name/URL)
// すら持たないものが無いかを確認する。config側のblocking判断はこの回のスコープ外 (delivery
// eventの発行はまだ実装しない) — deliver-stage/呼び出し側が必要に応じて使う。
export function hasUnattributableRequiredSource(attributions) {
  return attributions.some((entry) => entry.attributionRequired && !entry.url && !entry.sourceName);
}
