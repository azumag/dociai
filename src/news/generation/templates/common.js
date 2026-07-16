// 共有prompt断片 (issue #191): 記事情報とResearchBundleをprompt本文へ整形する。
// researchが無い(#190未着地/機械的provider失敗)場合も、記事情報だけで安全に生成継続できる
// よう明示的にfallback文言を出す。

export function formatCandidateBlock(candidate, { currentTime = null } = {}) {
  const meta = [
    currentTime ? `現在時刻: ${currentTime}` : null,
    `タイトル: ${candidate.title}`,
    candidate.sourceName ? `ソース: ${candidate.sourceName}` : null,
    candidate.publishedAt ? `日時: ${candidate.publishedAt}` : null,
    candidate.description ? `概要: ${candidate.description}` : null,
    candidate.content ? `本文抜粋: ${candidate.content.slice(0, 2000)}` : null,
  ].filter(Boolean);
  return `# 記事情報\n${meta.join("\n")}`;
}

function factText(fact) {
  return typeof fact === "string" ? fact : fact.text;
}

export function formatResearchBlock(research) {
  if (!research) return "# 調査結果\n(調査結果はありません。上の記事情報だけを根拠にしてください)";

  const facts = (research.facts ?? []).map((fact, index) => {
    const sourceRef = Array.isArray(fact.sourceIds) && fact.sourceIds.length ? fact.sourceIds.join(",") : fact.sourceUrl ?? "?";
    return `[F${index + 1}] ${factText(fact)} (confidence: ${fact.confidence ?? "medium"}, source: ${sourceRef})`;
  });
  const background = (research.background ?? []).map((entry, index) => `[B${index + 1}] ${factText(entry)}`);
  const viewpoints = (research.viewpoints ?? []).map((entry, index) => `[V${index + 1}] ${factText(entry)}`);
  const unresolved = (research.unresolved ?? []).map((entry) => `- ${entry}`);
  const sources = (research.sources ?? []).map((source) => `- ${source.id ?? source.sourceId ?? "?"}: ${source.sourceName ?? source.name ?? ""}`);

  const sections = [
    facts.length ? `## 確認できた事実\n${facts.join("\n")}` : null,
    background.length ? `## 背景\n${background.join("\n")}` : null,
    viewpoints.length ? `## 複数の視点\n${viewpoints.join("\n")}` : null,
    unresolved.length ? `## 未確認・対立する情報 (断定しない)\n${unresolved.join("\n")}` : null,
    sources.length ? `## 利用可能なsource id\n${sources.join("\n")}` : null,
  ].filter(Boolean);

  return `# 調査結果 (根拠。ここに無い固有名詞・日付・数値を追加しない)\n${sections.join("\n\n")}`;
}
