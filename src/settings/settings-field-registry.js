const patterns = [
  ["connectors.*", "connectors"], ["personas.*", "personas"], ["triggers.*", "triggers"], ["news.*", "news"], ["topics.*", "topics"], ["commentSources.*", "sources"], ["context.*", "context"], ["speechQueue.*", "speech"],
];
export function fieldMetadataForIssue(issue) {
  const path = issue.path.join(".");
  const match = patterns.find(([pattern]) => path.startsWith(pattern.replace(".*", "")));
  return Object.freeze({ ...issue, id: `${issue.code}:${path}`, tabId: match?.[1] ?? "general", fieldId: path, cardId: issue.path.slice(0, 2).join(".") });
}
