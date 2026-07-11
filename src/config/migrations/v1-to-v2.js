export const migrationV1ToV2 = Object.freeze({
  id: "v1-to-v2", from: 1, to: 2,
  migrate(input) {
    const config = structuredClone(input);
    if (config.commentSources?.twitch?.channel && !config.commentSources.twitch.channels) config.commentSources.twitch.channels = [config.commentSources.twitch.channel];
    if (config.commentSources?.twitch) delete config.commentSources.twitch.channel;
    config.schemaVersion = 2;
    return { config, notes: [] };
  },
});
