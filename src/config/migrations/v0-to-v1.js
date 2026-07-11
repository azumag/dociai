export const migrationV0ToV1 = Object.freeze({
  id: "v0-to-v1", from: 0, to: 1,
  migrate(input) {
    const config = structuredClone(input);
    const legacyTodoist = (config.news?.sources ?? []).filter((source) => source?.type === "todoist");
    if (legacyTodoist.length && !config.topics) {
      config.topics = { enabled: Boolean(config.news?.enabled), trigger: config.news?.trigger ?? "", persona: config.news?.persona ?? "", sources: legacyTodoist };
      config.news = { ...config.news, sources: config.news.sources.filter((source) => source?.type !== "todoist") };
    }
    config.schemaVersion = 1;
    return { config, notes: legacyTodoist.length ? ["news Todoist sources moved to topics"] : [] };
  },
});
