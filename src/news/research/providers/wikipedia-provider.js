// WikipediaProvider (issue #190): 背景語の補完用。ja→enのfallbackはこのproviderの責務では
// なく (契約の複雑化を避けるため既定languageのみを引く)、language切替は将来のmode policy
// 拡張で対応する。Electron Main限定。

import { searchWikipediaThroughElectron, cancelElectronWikipediaRequest, hasElectronWikipediaService } from "../../../platform/electron-services.js";
import { createProviderResult } from "../research-provider.js";
import { callElectronResearchIpc } from "./electron-ipc-provider.js";

export function createWikipediaProvider() {
  return {
    id: "wikipedia",
    supports(input, capabilities = {}) {
      return Boolean(capabilities.wikipedia ?? hasElectronWikipediaService()) && (input.queries?.length ?? 0) > 0;
    },
    async research(input, context) {
      const query = input.queries?.[0];
      if (!query) return null;
      const value = await callElectronResearchIpc({
        prefix: "wikipedia",
        query,
        context,
        call: (requestId) => searchWikipediaThroughElectron({ query, language: input.language ?? "ja", requestId }),
        cancel: cancelElectronWikipediaRequest,
      });
      const summary = value.summary;
      if (!summary?.extract) return null;
      return createProviderResult("wikipedia", {
        facts: [{ text: summary.extract.slice(0, input.maxCharsPerSource ?? 1200), sourceUrl: summary.url, sourceName: `Wikipedia: ${summary.title}`, confidence: "medium", kind: "background" }],
        sources: summary.url ? [{ url: summary.url, sourceName: `Wikipedia: ${summary.title}`, isPrimary: false }] : [],
      });
    },
  };
}
