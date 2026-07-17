// Browser/Electron capability判定 (issue #188)。stage/UIはここだけを見て機能制限を表示し、
// hasElectron*Service()を個別に問い合わせない。

import { hasElectronFeedService, hasElectronNewsArticleService, hasElectronNewsSearchService, hasElectronWikipediaService } from "../platform/electron-services.js";

export function getNewsSourceCapabilities() {
  const articleFetch = hasElectronNewsArticleService();
  return {
    feedFetch: hasElectronFeedService(),
    articleFetch,
    // Google News redirect解決はarticle fetchと同じElectron Main経路 (SafeHttpClientの
    // redirect追従) に相乗りするため、articleFetchが使えるなら常に使える。
    googleNewsResolve: articleFetch,
    persistentCache: false, // memory cacheのみ (Electron永続repositoryは#188フォローアップ)
    // issue #190: news検索/Wikipedia調査。Browserではどちらも使えない (外部searchのcapability
    // 差はUI/statusで明示する)。
    newsSearch: hasElectronNewsSearchService(),
    wikipedia: hasElectronWikipediaService(),
  };
}
