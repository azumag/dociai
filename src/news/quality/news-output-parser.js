// NewsOutputParser (issue #192)
// generation(#191)が要求したmarker区切り出力を解析する。marker完全一致を最優先し、
// markdown code fenceを除去して再解析、marker欠落時は最長の自然言語segmentをbody候補にする。

import { NEWS_OUTPUT_MARKERS, NEWS_OUTPUT_MARKER_ORDER } from "../generation/news-output-contract.js";

function stripCodeFences(text) {
  return String(text ?? "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
}

// marker重複時は「本文らしさ」の簡易代理として、より長いsegmentを採用する。
function splitByMarkers(text) {
  const positions = [];
  for (const marker of NEWS_OUTPUT_MARKER_ORDER) {
    let searchFrom = 0;
    for (;;) {
      const index = text.indexOf(marker, searchFrom);
      if (index < 0) break;
      positions.push({ marker, index });
      searchFrom = index + marker.length;
    }
  }
  positions.sort((a, b) => a.index - b.index);

  const sections = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index + positions[i].marker.length;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    const marker = positions[i].marker;
    const content = text.slice(start, end).trim();
    if (!(marker in sections) || content.length > sections[marker].length) sections[marker] = content;
  }
  return sections;
}

function longestNaturalLanguageSegment(text) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return "";
  return blocks.reduce((best, block) => (block.length > best.length ? block : best), "");
}

function splitLines(value) {
  return String(value ?? "").split("\n").map((line) => line.trim()).filter((line) => line && line !== "なし");
}

// research (もし渡されれば) に実在するsource idだけをsourceIdsとして採用する — LLMが
// 存在しないidを捏造しても、grounding検査より前にここで除外する (issue #192「source id偽造」)。
export function parseNewsOutput(rawText, { validSourceIds = null } = {}) {
  const warnings = [];
  const cleaned = stripCodeFences(rawText);
  const sections = splitByMarkers(cleaned);

  const titleSpoken = sections[NEWS_OUTPUT_MARKERS.TITLE] ?? "";
  if (!titleSpoken) warnings.push("title_marker_missing");

  let body = sections[NEWS_OUTPUT_MARKERS.BODY] ?? "";
  if (!body) {
    warnings.push("body_marker_missing");
    body = longestNaturalLanguageSegment(cleaned);
  }

  const summary = sections[NEWS_OUTPUT_MARKERS.SUMMARY] ?? "";
  if (!summary) warnings.push("summary_marker_missing");

  const entities = splitLines(sections[NEWS_OUTPUT_MARKERS.ENTITIES]);

  let sourceIds = splitLines(sections[NEWS_OUTPUT_MARKERS.SOURCE_IDS]);
  if (validSourceIds) {
    const before = sourceIds.length;
    sourceIds = sourceIds.filter((id) => validSourceIds.has(id));
    if (sourceIds.length < before) warnings.push("source_id_forged_removed");
  }

  return { titleSpoken, body, summary, entities, sourceIds, parserWarnings: warnings };
}
