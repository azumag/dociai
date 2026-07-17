// NewsDelivery契約 (issue #193)。deliver stageとcoordinator/呼び出し側はここに定義した形
// だけを介してやり取りする。SpeechQueueのitemへ積む本文と、attribution等のmetadataは
// 分離して保持する (metadataは音声engineへ渡さない)。

export function createNewsSpeechMetadata({ runId = null, candidateId = null, mode = null, title = "", summary = "", sourceIds = [], attribution = [] } = {}) {
  return {
    source: "news",
    runId,
    candidateId,
    mode,
    title: String(title ?? ""),
    summary: String(summary ?? ""),
    sourceIds: [...sourceIds],
    attribution: [...attribution],
  };
}
