// 英語CCの受理policy (issue #282)。Chromeワーカーから届いた1件を「Twitchへ送ってよいか」だけで
// 判断する純粋ロジックと、送出待ちの有界キュー。
//
// ここにはI/Oを一切置かない — WebSocket・OBS・Electronに触れないので、
// scripts/test/caption-policy.test.mjs が素のNodeでそのまま検証できる
// (electron/main/ipc/translation-input.ts が register.ts から切り出されているのと同じ理由)。
//
// 「翻訳失敗時に日本語原文を送るフォールバックは設けず、その字幕を破棄する」がissueの明示要件
// なので、このファイルには原文へフォールバックする経路自体が存在しない。
import { MAX_CAPTION_TEXT_CHARS, MAX_RECOGNIZED_TEXT_CHARS } from "../../../shared/services/caption-contract";
import type { CaptionRejectReason } from "../../../shared/services/caption-contract";

export type CaptionPolicyOptions = {
  maxPending: number;
  maxAgeMs: number;
  // 0 = 分割しない。実表示可能文字数はissue #282 Phase 0の実機検証で確定する項目なので、
  // 既定値をコード側で断定せず「運用者が設定で決める」形にしてある。
  maxCaptionChars: number;
  replacements: Record<string, string>;
};

export type CaptionInput = { sequence: number; isFinal: boolean; recognized: string; text: string; ageMs: number };
export type CaptionEvaluation =
  | { ok: true; segments: string[]; recognized: string; text: string }
  | { ok: false; reason: CaptionRejectReason };

// `source` は分割前の字幕全文。#lastSent (重複排除の記憶) と突き合わせるために持つ —
// segmentだけだと、分割された字幕を捨てたときに「その字幕が記憶の主かどうか」が判定できない。
export type QueuedCaption = { sequence: number; text: string; source: string; enqueuedAt: number; initialAgeMs: number };

// C0/C1制御文字。タブ・改行・復帰だけは「認識器/翻訳器が挟んでくる正常な空白」として
// normalizeCaptionText()が空白へ潰すので、ここでは違反扱いにしない。
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// ひらがな・カタカナ・CJK統合漢字・CJK互換漢字・CJK句読点 (、。「」等)・半角カタカナと
// 半角句読点/濁点 (｡｢｣､･ﾞﾟ)・CJK拡張B以降 (サロゲートペア)。英訳結果にこれらが
// 残っていたら翻訳が失敗している (もしくは素通しされている) ので、日本語をTwitchへ送らないため
// に破棄する — issue #282 受け入れ条件「Twitch側へ日本語原文を一切送らない」の実装本体。
// U+3000 (全角スペース) だけは正規化で半角スペースへ潰してから判定するので対象外。
const SOURCE_LANGUAGE_CHARACTERS = /[\u3001-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff61-\uff9f]|[\u{20000}-\u{3ffff}]/u;

export function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

export function containsSourceLanguage(value: string): boolean {
  return SOURCE_LANGUAGE_CHARACTERS.test(value);
}

// 全角スペース・タブ・改行を半角スペース1個へ潰し、前後を落とす。CEA-608の1行表示に改行を
// そのまま渡しても意味が無く、行分割はsplitCaption()側の責務。
export function normalizeCaptionText(value: string): string {
  return value.replace(/[　\s]+/g, " ").trim();
}

// 固有名詞の最終置換 (配信者名・番組名など、翻訳器が毎回崩す語の後処理)。
// 長いキーから順に1回ずつ適用する — 短いキーが長いキーの一部を先に壊すのを防ぐため。
// 置換結果を再走査しないので、辞書がお互いを参照していても無限ループにならない。
export function applyCaptionReplacements(value: string, replacements: Record<string, string>): string {
  const entries = Object.entries(replacements ?? {}).filter(([from]) => from.length > 0).sort((a, b) => b[0].length - a[0].length);
  if (!entries.length) return value;
  let result = "";
  let index = 0;
  outer: while (index < value.length) {
    for (const [from, to] of entries) {
      if (value.startsWith(from, index)) { result += to; index += from.length; continue outer; }
    }
    result += value[index];
    index += 1;
  }
  return result;
}

// maxChars以下の断片へ分割する。語境界を優先し、1語がmaxCharsを超える場合だけ強制的に切る。
export function splitCaption(value: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0 || value.length <= maxChars) return [value];
  const segments: string[] = [];
  let rest = value;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const boundary = window.lastIndexOf(" ");
    const cut = boundary > 0 ? boundary : maxChars;
    segments.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length) segments.push(rest);
  return segments.filter((segment) => segment.length > 0);
}

export class CaptionPolicy {
  #options: CaptionPolicyOptions;
  #generation = 0;
  #lastSent = "";
  #queue: QueuedCaption[] = [];

  constructor(options: CaptionPolicyOptions) {
    this.#options = { ...options, replacements: { ...(options.replacements ?? {}) } };
  }

  get generation(): number { return this.#generation; }
  get pending(): number { return this.#queue.length; }
  get options(): CaptionPolicyOptions { return { ...this.#options, replacements: { ...this.#options.replacements } }; }

  // 停止・設定reload・OBS再接続のたびに呼ぶ。世代を進めることで、進行中の (もう関係ない)
  // 字幕が後から届いても stale-generation として落ちる。
  reset(): number {
    this.#generation += 1;
    this.#lastSent = "";
    this.#queue = [];
    return this.#generation;
  }

  configure(options: CaptionPolicyOptions): void {
    this.#options = { ...options, replacements: { ...(options.replacements ?? {}) } };
    if (this.#queue.length > this.#options.maxPending) this.#queue = this.#queue.slice(-this.#options.maxPending);
  }

  evaluate(input: CaptionInput, context: { connectionGeneration: number }): CaptionEvaluation {
    if (context.connectionGeneration !== this.#generation) return { ok: false, reason: "stale-generation" };
    if (!input.isFinal) return { ok: false, reason: "not-final" };
    if (typeof input.text !== "string" || typeof input.recognized !== "string") return { ok: false, reason: "empty" };
    if (input.text.length > MAX_CAPTION_TEXT_CHARS || input.recognized.length > MAX_RECOGNIZED_TEXT_CHARS) return { ok: false, reason: "too-long" };
    if (hasControlCharacters(input.text) || hasControlCharacters(input.recognized)) return { ok: false, reason: "control-characters" };
    if (!Number.isFinite(input.ageMs) || input.ageMs < 0) return { ok: false, reason: "expired" };
    const normalized = applyCaptionReplacements(normalizeCaptionText(input.text), this.#options.replacements);
    if (!normalized.length) return { ok: false, reason: "empty" };
    if (containsSourceLanguage(normalized)) return { ok: false, reason: "source-language-leak" };
    if (input.ageMs > this.#options.maxAgeMs) return { ok: false, reason: "expired" };
    if (normalized === this.#lastSent) return { ok: false, reason: "duplicate" };
    this.#lastSent = normalized;
    return { ok: true, segments: splitCaption(normalized, this.#options.maxCaptionChars), recognized: normalizeCaptionText(input.recognized), text: normalized };
  }

  // 有界キュー: 上限を超えたら「古い方」を捨てて現在の発話を優先する (issue #282)。
  // 捨てた件数と、捨てた字幕のsequence一覧を返す — 呼び出し側がrejected counterへ反映し、
  // そのsequenceへ queue-overflow のackを返せるようにするため。
  //
  // 追い出しの対象は「以前の発話」だけで、いま積んでいる発話自身の先頭segmentは決して捨てない。
  // 素直に head から追い出すと、maxCaptionCharsで3つ以上に分割された字幕が空のキューでも
  // 自分の s1 を追い出し、Twitchには文の途中から始まる断片だけが出てしまう。上限に収まらない
  // 分は末尾を落とし、先頭 (文の始まり) と読み順を残す。
  enqueue(segments: string[], context: { sequence: number; now: number; ageMs: number; source: string }): { dropped: number; droppedSequences: number[]; droppedSources: string[] } {
    let dropped = 0;
    const droppedSequences: number[] = [];
    const droppedSources: string[] = [];
    const drop = (entry: QueuedCaption | undefined): void => {
      dropped += 1;
      if (!entry) return;
      if (!droppedSequences.includes(entry.sequence)) droppedSequences.push(entry.sequence);
      if (!droppedSources.includes(entry.source)) droppedSources.push(entry.source);
    };
    const entry = (text: string): QueuedCaption => ({ sequence: context.sequence, text, source: context.source, enqueuedAt: context.now, initialAgeMs: context.ageMs });
    for (const text of segments) {
      // まず以前の発話を追い出して席を空ける。
      while (this.#queue.length >= this.#options.maxPending && this.#queue[0].sequence !== context.sequence) drop(this.#queue.shift());
      // それでも空かない = この発話自身のsegmentだけでキューが埋まっている。末尾を落とす。
      if (this.#queue.length >= this.#options.maxPending) { drop(entry(text)); continue; }
      this.#queue.push(entry(text));
    }
    return { dropped, droppedSequences, droppedSources };
  }

  // 送出直前に呼ぶ。キュー待ち時間を足したうえで期限切れを捨て、先頭1件だけを返す。
  // ageMsはworker側の相対時刻 (認識final -> 送信) なので、wall clockのずれに影響されない。
  take(now: number): { caption: QueuedCaption | null; expired: number; expiredSources: string[] } {
    let expired = 0;
    const expiredSources: string[] = [];
    while (this.#queue.length) {
      const head = this.#queue[0];
      if ((now - head.enqueuedAt) + head.initialAgeMs > this.#options.maxAgeMs) {
        this.#queue.shift();
        expired += 1;
        if (!expiredSources.includes(head.source)) expiredSources.push(head.source);
        continue;
      }
      this.#queue.shift();
      return { caption: head, expired, expiredSources };
    }
    return { caption: null, expired, expiredSources };
  }

  // 受理はしたが結局Twitchへ届かなかった (queue溢れ・期限切れ・OBS送出失敗) 場合に、
  // 重複排除の記憶を外す。外さないと「一度も出ていない字幕」と同じ文を言い直したときに
  // duplicateとして落ち続ける。
  //
  // 捨てた字幕の全文を渡すこと。無条件に消すと、記憶に入っているのは常に「最後に受理した字幕」=
  // まだキューに残っていてこれから送出される字幕なので、古い字幕が溢れただけでこれから出る
  // 字幕の記憶まで消え、直後に同じ文が届くとTwitchへ二重に出てしまう。
  forgetLastSent(source: string): void { if (source === this.#lastSent) this.#lastSent = ""; }

  // 再接続直後・停止時に「古い字幕を後から流さない」ためのキュー破棄 (世代は据え置き)。
  // 捨てたsequence一覧も返す — 溢れ時と同じようにworkerへ破棄を伝えられるようにするため
  // (返さないと、ワーカータブ側の破棄件数だけが実際より少なく見える)。
  clearQueue(): { dropped: number; droppedSequences: number[]; droppedSources: string[] } {
    const droppedSequences: number[] = [];
    const droppedSources: string[] = [];
    for (const entry of this.#queue) {
      if (!droppedSequences.includes(entry.sequence)) droppedSequences.push(entry.sequence);
      if (!droppedSources.includes(entry.source)) droppedSources.push(entry.source);
    }
    const dropped = this.#queue.length;
    this.#queue = [];
    return { dropped, droppedSequences, droppedSources };
  }
}
