// GroundingValidator (issue #192): 本文中の数字・固有名詞をResearchBundle (facts/background)
// と照合する。researchが無い場合は比較対象が無いため、grounding違反自体を判定しない
// (issue #186不変条件「記事本文・調査結果に無い固有名詞、日付、数値を断定しない」は、
// researchが存在する時にだけ機械的に検査できる)。

function extractNumbers(text) {
  return [...text.matchAll(/\d+(?:[.,]\d+)?%?/g)].map((match) => match[0]);
}

function factText(fact) {
  return typeof fact === "string" ? fact : fact.text;
}

export function validateGrounding(text, { research = null, entities = [] } = {}) {
  if (!research) return { failures: [], groundedNumberRatio: null, groundedEntityRatio: null };

  const groundedText = [...(research.facts ?? []).map(factText), ...(research.background ?? []).map(factText)].join("\n");

  const failures = [];
  const numbers = extractNumbers(text);
  const ungroundedNumbers = numbers.filter((n) => !groundedText.includes(n));
  const groundedNumberRatio = numbers.length ? (numbers.length - ungroundedNumbers.length) / numbers.length : 1;
  if (ungroundedNumbers.length) failures.push({ code: "ungrounded_number", severity: "rewrite", detail: ungroundedNumbers.slice(0, 5).join(",") });

  const ungroundedEntities = entities.filter((entity) => entity && !groundedText.includes(entity));
  const groundedEntityRatio = entities.length ? (entities.length - ungroundedEntities.length) / entities.length : 1;
  if (ungroundedEntities.length) failures.push({ code: "ungrounded_entity", severity: "warning", detail: ungroundedEntities.slice(0, 5).join(",") });

  return { failures, groundedNumberRatio, groundedEntityRatio };
}
