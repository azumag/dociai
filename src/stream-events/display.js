// Issue #89: pure display formatter — turns a validated StreamEvent into
// `{ icon, label, summary, value }` for UI/OBS rendering. Deliberately separate from whatever text
// a trigger/persona-response system builds from the same event (that's a different consumer of the
// same bus, per the issue's "UI/OBS向け表示をtrigger promptと分離できる" acceptance criterion) —
// nothing here does I/O, touches the DOM, or has any side effect; every function is a plain
// `(event) -> value` mapping.
//
// Labels follow this repo's existing Japanese UI-label convention (see src/config/config-
// registry.js's `eventTypes`/`actionTypes` descriptors, e.g. "コメント"/"サブスク"/"チャネルポイント").

const TIER_LABEL = Object.freeze({ 1000: "1", 2000: "2", 3000: "3", prime: "Prime" });
const TIER_RANK = Object.freeze({ 1000: 1, 2000: 2, 3000: 3, prime: 1 });

function tierLabel(tier) {
  return TIER_LABEL[tier] ?? String(tier);
}

function tierRank(tier) {
  return TIER_RANK[tier] ?? 0;
}

function actorName(event) {
  return event?.actor?.displayName || (event?.actor?.isAnonymous ? "匿名ユーザー" : "unknown");
}

const FORMATTERS = Object.freeze({
  cheer: (event) => {
    const bits = event.data?.bits ?? 0;
    const withMessage = event.data?.message ? `「${event.data.message}」` : "";
    return {
      icon: "💎",
      label: "Bits",
      summary: `${actorName(event)} が ${bits} bits を送りました${withMessage}`,
      value: bits,
    };
  },
  subscription: (event) => {
    const tier = event.data?.tier;
    return {
      icon: "⭐",
      label: "新規サブスク",
      summary: `${actorName(event)} が Tier ${tierLabel(tier)} でサブスクしました${event.data?.isGift ? "（ギフト）" : ""}`,
      value: tierRank(tier),
    };
  },
  resub: (event) => {
    const months = event.data?.cumulativeMonths ?? 0;
    const withMessage = event.data?.message ? `「${event.data.message}」` : "";
    return {
      icon: "🔁",
      label: "継続サブスク",
      summary: `${actorName(event)} が ${months}ヶ月継続サブスク（Tier ${tierLabel(event.data?.tier)}）${withMessage}`,
      value: months,
    };
  },
  "gift-subscription": (event) => {
    const count = event.data?.count ?? 0;
    return {
      icon: "🎁",
      label: "ギフトサブスク",
      summary: `${actorName(event)} が ${count}件のギフトサブスク（Tier ${tierLabel(event.data?.tier)}）を贈りました`,
      value: count,
    };
  },
  "reward-redemption": (event) => {
    const cost = event.data?.cost ?? 0;
    const rewardTitle = event.data?.rewardTitle ?? "";
    const withInput = event.data?.userInput ? `：${event.data.userInput}` : "";
    return {
      icon: "🏆",
      label: "チャネルポイント",
      summary: `${actorName(event)} が『${rewardTitle}』(${cost}pt) を交換しました${withInput}`,
      value: cost,
    };
  },
});

/** Turns a StreamEvent into `{ icon, label, summary, value }`. Assumes `event` already passed
 * validateStreamEvent() — an unrecognized `kind` (e.g. a future kind this build doesn't know
 * about yet) falls back to a generic, still-safe rendering rather than throwing, so a stale UI
 * build never crashes on a StreamEvent from a newer producer. */
export function formatStreamEvent(event) {
  const formatter = FORMATTERS[event?.kind];
  if (!formatter) {
    return { icon: "❔", label: "不明なイベント", summary: `${actorName(event)} が不明な種類のイベントを発生させました`, value: 0 };
  }
  return formatter(event);
}
