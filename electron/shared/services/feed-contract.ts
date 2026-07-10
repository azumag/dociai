export type FeedItem = {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
  guid: string;
  sourceName: string;
  sourceIndex: number;
};

export type FeedFetchInput = { sourceIndex: number; requestId?: string; generation?: number; ownerId?: string };
export type FeedFetchResponse = { items: FeedItem[]; requestId: string };
