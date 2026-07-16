// source diversity score (issue #189): 直近配信sourceの出現回数の逆数 + 直前と同一source連続への
// penalty + config補正。

export function sourceDiversityWeight(sourceId, { recentSourceIds = [], lastSourceId = null, sourcePriority = {} } = {}) {
  const occurrences = recentSourceIds.filter((id) => id === sourceId).length;
  let weight = 1 / (1 + occurrences);
  if (lastSourceId && lastSourceId === sourceId) weight *= 0.5;
  const priority = sourcePriority[sourceId] ?? 1;
  return Math.max(0, weight * priority);
}
