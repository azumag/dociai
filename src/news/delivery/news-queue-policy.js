// NewsQueuePolicy (issue #193): SpeechQueueへ配信する前のaccept/defer判定。
// 実際のenqueue()呼び出しはdeliver stageだけが行う (issue #186の「delivery stage以外は
// 音声queueへ触らない」不変条件) — ここは副作用を持たない純粋な判定だけを行う。

export function decideQueueAcceptance({ pendingItems = [], candidateId = null, mode = null, deferWhenQueueAbove = null }) {
  const duplicate = candidateId != null && pendingItems.some((item) => item.metadata?.candidateId === candidateId && item.metadata?.mode === mode);
  if (duplicate) return { accept: false, reason: "duplicate-candidate" };
  if (deferWhenQueueAbove != null && pendingItems.length > deferWhenQueueAbove) return { accept: false, reason: "queue-congested" };
  return { accept: true, reason: null };
}
