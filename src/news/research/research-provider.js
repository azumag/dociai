// NewsResearchProvider契約 (issue #190)。
//
//   type NewsResearchProvider = {
//     id: string;
//     supports(input: ResearchRequest, capabilities: RuntimeCapabilities): boolean;
//     research(input: ResearchRequest, context: RequestContext): Promise<ProviderResult | null>;
//   };
//
//   type ResearchRequest = { candidate, mode, maxSources, maxCharsPerSource, language };
//
//   type ProviderResult = {
//     providerId: string;
//     facts: Array<{ text, sourceUrl?, sourceName?, confidence?, kind? }>;
//     sources: Array<{ url, sourceName, publishedAt?, license?, isPrimary? }>;
//     unresolved?: string[];
//   };
//
// providerはraw HTML/tool log/provider errorを外へ漏らさない。coordinatorは1 providerの
// 失敗で研究全体を止めない — providerは例外を投げてよく、coordinator側でcatchする。

export function createProviderResult(providerId, { facts = [], sources = [], unresolved = [] } = {}) {
  return { providerId, facts, sources, unresolved };
}
