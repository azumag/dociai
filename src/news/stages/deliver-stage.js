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
import { buildAttributions, hasUnattributableRequiredSource } from "../delivery/news-attribution.js";
import { createNewsSpeechMetadata } from "../delivery/news-delivery-contract.js";
import { decideQueueAcceptance } from "../delivery/news-queue-policy.js";
import { TERMINAL_SPEECH_STATES } from "../../speech/speech-item.js";

export function createNewsDeliveryStage({ speechQueue, sourceLabel = "newstalk", deferWhenQueueAbove = null, priority, log = () => {}, blockOnUnattributableRequiredSource = true }) {
  return {
    id: "deliver",
    async run({ persona, item, text, research, modePolicy, runId }, _context) {
      const attribution = buildAttributions(research, item);
      // CC等attributionRequiredなsourceの出典を実際に表示できない (name/URLどちらも無い)
      // 場合、warningで済ませず配信自体を止める (issue #193「delivery failureまたは
      // 設定に応じたblocking」)。データ不備は再試行しても直らないためnon-retryable。
      // blockOnUnattributableRequiredSource: falseで警告ログのみへ緩和できる。
      if (hasUnattributableRequiredSource(attribution)) {
        if (blockOnUnattributableRequiredSource) {
          throw new PipelineStageError(`attribution requiredな出典を表示できないため配信をblockしました [${item.title}]`, { stage: "deliver", kind: "unattributable" });
        }
        log(`attribution requiredな出典の名前/URLが不足しています [${item.title}]`, "warn");
      }
      const metadata = createNewsSpeechMetadata({
        runId: runId ?? null,
        candidateId: item.processingKey ?? item.guid ?? null,
        mode: modePolicy?.mode ?? null,
        title: item.title ?? "",
        summary: item.description ?? "",
        sourceIds: (research?.sources ?? []).map((source) => source.id).filter(Boolean),
        attribution,
      });

      // 「waiting」だけでなく、今まさに読み上げ中 (state: "speaking") のitemも重複/congestion
      // 判定へ含める。current itemを取りこぼすと、cancel直後の再試行で同じ候補が二重に
      // enqueueされ得る (issue #193レビュー指摘)。
      const pendingSameSource = (speechQueue.items ?? []).filter((entry) => entry.source === sourceLabel && !TERMINAL_SPEECH_STATES.has(entry.state));
      const decision = decideQueueAcceptance({ pendingItems: pendingSameSource, candidateId: metadata.candidateId, mode: metadata.mode, deferWhenQueueAbove });
      if (!decision.accept) {
        // 重複はretryしても解消しない (同じcandidateが既に読み上げ中/待機中なだけ) ため
        // permanent扱いにする。congestionだけがretry対象。
        throw new PipelineStageError(`ニュース配信をキューへ投入できませんでした (${decision.reason})`, { stage: "deliver", kind: decision.reason === "queue-congested" ? "server" : "duplicate" });
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
