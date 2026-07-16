// NewsQualityReportの既定形 (issue #192)。

export function emptyQualityReport(overrides = {}) {
  return {
    passed: true,
    failures: [],
    metrics: { chars: 0, japaneseRatio: 0, sentenceCount: 0, maxSentenceRepetition: 0, groundedEntityRatio: null, groundedNumberRatio: null },
    parsed: null,
    ...overrides,
  };
}
