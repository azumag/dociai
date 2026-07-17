// ResearchCache (issue #190)。query+日付bucket+modeでcache keyを作る。TTL既定30分。
// raw provider responseではなく、正規化済みbundleだけを保存する。cancellation時のpartial
// resultはsuccess cacheへ保存しない (呼び出し側が結果が揃った時にだけset()する契約)。

function dateBucket(now) {
  return new Date(now).toISOString().slice(0, 13); // 時間単位のbucket
}

// mode/researchMode/candidateIdをすべてkeyへ含める。queryだけをkeyにすると、cleanした
// headlineが同じ2つの別candidateが互いのbundle (candidateId/headlineを内包する) を受け取って
// しまい、また同じ時間帯にresearchMode ("article"⇔"multi_source") がconfig差し替えで変わった
// requestが古いbundleを誤って再利用してしまう (issue #190 review指摘)。
export function buildResearchCacheKey({ query, mode, now = Date.now(), researchMode = "unknown", candidateId = "unknown" }) {
  return `${mode}:${researchMode}:${candidateId}:${dateBucket(now)}:${query}`;
}

export function createResearchCache({ ttlMs = 30 * 60 * 1000, clock = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= clock()) { entries.delete(key); return null; }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: clock() + ttlMs });
    },
    clear() {
      entries.clear();
    },
  };
}
