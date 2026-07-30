const patterns = [
  ["connectors.*", "connectors"], ["personas.*", "personas"], ["triggers.*", "triggers"], ["news.*", "news"], ["topics.*", "topics"], ["commentSources.*", "sources"], ["context.*", "context"], ["speechQueue.*", "speech"],
  // issue #257 Phase 4 (#263): commentReader.translation.* validation issues (config-validation.js)
  // must navigate to the commentReader tab, not silently fall through to the nonexistent
  // "general" tab id (#activateTab("general") no-ops since no sidebar tab has that id).
  ["commentReader.*", "commentReader"],
];
export function fieldMetadataForIssue(issue) {
  const path = issue.path.join(".");
  const match = patterns.find(([pattern]) => path.startsWith(pattern.replace(".*", "")));
  return Object.freeze({ ...issue, id: `${issue.code}:${path}`, tabId: match?.[1] ?? "general", fieldId: path, cardId: issue.path.slice(0, 2).join(".") });
}
