export type TopicItem = {
  title: string;
  description: string;
  publishedAt: string | null;
  guid: string;
  sourceName: string;
  sourceIndex: number;
  taskId: string;
  kind: "topic";
};

export type TopicFetchInput = { sourceIndex: number; requestId?: string; generation?: number; ownerId?: string };
export type TopicFetchResponse = { items: TopicItem[]; requestId: string };
export type TopicCompleteInput = { sourceIndex: number; taskId: string; requestId?: string; generation?: number; ownerId?: string };
