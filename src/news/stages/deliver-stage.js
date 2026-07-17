// deliver stage (issue #187) — SpeechQueueへの投入。
// このstageだけが音声queueへ触れる (issue #186の不変条件「delivery stage以外は音声queueへ
// 触らない」)。Phase 1では legacy adapter の deliver() (enqueue + drop警告ログ) をそのまま呼ぶ。

export function createDeliverStage({ adapter }) {
  return {
    id: "deliver",
    async run({ persona, item, text }, _context) {
      return adapter.deliver({ persona, item, text });
    },
  };
}

// createNewsDeliveryStage(): issue #193の新実装。NewsSpeechMetadata (attribution込み) を
// 組み立て、queue congestion/重複判定 (news-queue-policy.js) を経てSpeechQueue.enqueue()を
// 呼ぶ — #186の「delivery stage以外は音声queueへ触らない」不変条件はここでも守る。
//
// commit判定は既存のstage契約 (throw/正常returnでretry/commitをcoordinatorへ委ねる、
// news-pipeline-coordinator.jsのheader comment参照) にそのまま乗せる: 受理 (accepted/held)
// は正常returnし、congestion/重複はPipelineStageError (retryable kind) をthrowして既存の
// retry/failed_permanent経路へ委ねる。呼び出し側 (coordinator) の変更は不要。
//
// commitPolicy "on-playback-complete" (実際の再生完了を待ってからcommitする厳密policy、
// issue本文の`NewsReadCommitPolicy`) はここでは実装しない — SpeechQueueのonUpdateは
// constructor時の単一callbackしか持たず、複数購読者向けのsubscribe機構が無い。導入する
// なら SpeechQueue へ subscribe() を足す専用の変更として別途行う。既定の"on-queue-accept"
// (受理した時点でcommit可) だけをこの回で提供する。
import { PipelineStageError } from "../contracts.js";
import { buildAttributions } from "../delivery/news-attribution.js";
import { createNewsSpeechMetadata } from "../delivery/news-delivery-contract.js";
import { decideQueueAcceptance } from "../delivery/news-queue-policy.js";

export function createNewsDeliveryStage({ speechQueue, sourceLabel = "newstalk", deferWhenQueueAbove = null, priority, log = () => {} }) {
  return {
    id: "deliver",
    async run({ persona, item, text, research, modePolicy, runId }, _context) {
      const attribution = buildAttributions(research, item);
      const metadata = createNewsSpeechMetadata({
        runId: runId ?? null,
        candidateId: item.processingKey ?? item.guid ?? null,
        mode: modePolicy?.mode ?? null,
        title: item.title ?? "",
        summary: item.description ?? "",
        sourceIds: (research?.sources ?? []).map((source) => source.id).filter(Boolean),
        attribution,
      });

      const pendingSameSource = (speechQueue.items ?? []).filter((entry) => entry.source === sourceLabel && entry.state === "waiting");
      const decision = decideQueueAcceptance({ pendingItems: pendingSameSource, candidateId: metadata.candidateId, mode: metadata.mode, deferWhenQueueAbove });
      if (!decision.accept) {
        throw new PipelineStageError(`ニュース配信をキューへ投入できませんでした (${decision.reason})`, { stage: "deliver", kind: decision.reason === "queue-congested" ? "server" : "empty" });
      }

      const queued = speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text, voice: persona.voice, source: sourceLabel, priority, metadata });
      if (queued?.state === "dropped") {
        throw new PipelineStageError(`ニュース音声はキュー上限で破棄されました [${item.title}]`, { stage: "deliver", kind: "server" });
      }
      log(`ニュース配信をキューへ投入しました [${item.title}]`);
      return { status: speechQueue.paused ? "held" : "accepted", queueItemId: queued?.id ?? null, commitAllowed: true, reason: null, attribution };
    },
  };
}
