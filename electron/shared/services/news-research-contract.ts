// issue #190: news検索/Wikipedia調査の契約。どちらもfixed host (news.google.com /
// ja.wikipedia.org 等) だけを叩く — Rendererが任意URLを指定することはない。

export type NewsSearchResult = { title: string; link: string; snippet: string; sourceName: string; publishedAt: string | null };
export type NewsSearchInput = { query: string; language?: string; requestId?: string; generation?: number; ownerId?: string };
export type NewsSearchResponse = { results: NewsSearchResult[]; requestId: string };

export type WikipediaSummary = { title: string; extract: string; url: string | null };
export type WikipediaSearchInput = { query: string; language?: string; requestId?: string; generation?: number; ownerId?: string };
export type WikipediaSearchResponse = { summary: WikipediaSummary | null; requestId: string };
