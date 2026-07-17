// NewsResearchBundle契約 (issue #190)。generate stage (#191) はこの正規化済み形だけを
// 根拠として受け取り、raw provider response・tool log・HTML全文を直接見ない。

export function emptyResearchBundle(overrides = {}) {
  return {
    candidateId: null,
    headline: "",
    facts: [],
    background: [],
    viewpoints: [],
    unresolved: [],
    sources: [],
    coverage: { sourceCount: 0, independentPublisherCount: 0, hasPrimarySource: false, hasConflictingClaims: false },
    generatedAt: null,
    fallbackPath: [],
    ...overrides,
  };
}
