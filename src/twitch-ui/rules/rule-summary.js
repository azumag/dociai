// Issue #95: pure, DOM-free summary helpers for one EventTriggerConfig rule — reused by both
// rule-list.js (one line per rule) and rule-editor.js (a header recap while editing). Kept
// deliberately side-effect-free (no DOM) so every function here is directly unit-testable, the same
// split components/preflight-check.js established for #94 (`computePreflightChecks` vs
// `renderPreflightChecks`).
import { isConditionGroupNode, isConditionLeafNode } from "../../triggers/event-trigger-schema.js";
import { isUnknownReward } from "./reward-selector.js";

function formatConditionValue(value) {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "" || value === null || value === undefined) return "(未設定)";
  return String(value);
}

/** One-line, human-readable recap of a condition tree — "すべて満たす: data.bits ≧ 100 かつ
 * actor.isAnonymous = false" style. Never throws on a malformed node (a hand-edited config file
 * could have one) — falls back to a visible "(不明な条件)" marker instead. */
export function summarizeCondition(node, depth = 0) {
  if (isConditionGroupNode(node)) {
    const key = Array.isArray(node.all) ? "all" : "any";
    const children = node[key] ?? [];
    if (children.length === 0) return "(条件なし)";
    const joiner = key === "all" ? " かつ " : " または ";
    const body = children.map((child) => summarizeCondition(child, depth + 1)).join(joiner);
    return depth === 0 ? body : `(${body})`;
  }
  if (isConditionLeafNode(node)) {
    return `${node.field ?? "?"} ${node.operator ?? "?"} ${formatConditionValue(node.value)}`;
  }
  return "(不明な条件)";
}

/** "budget" column text — cooldown + rate-limit + aggregation, the throttling config this issue's
 * own rule-list bullet groups together (distinct from the per-action editor). `"-"` when none of the
 * three are configured. */
export function summarizeBudget(rule) {
  const parts = [];
  if (rule?.cooldown?.cooldownMs) {
    const seconds = Math.round(rule.cooldown.cooldownMs / 1000);
    const dims = Array.isArray(rule.cooldown.keyBy) && rule.cooldown.keyBy.length ? `/${rule.cooldown.keyBy.join("+")}` : "";
    parts.push(`CD ${seconds}s${dims}`);
  }
  if (rule?.rateLimit?.windowMs && rule?.rateLimit?.maxActions) {
    parts.push(`RL ${rule.rateLimit.maxActions}/${Math.round(rule.rateLimit.windowMs / 1000)}s→${rule.rateLimit.overflowPolicy ?? "drop"}`);
  }
  if (rule?.aggregation?.windowMs) {
    parts.push(`AGG ${Math.round(rule.aggregation.windowMs / 1000)}s/${rule.aggregation.maxBatchSize ?? "?"}`);
  }
  return parts.length ? parts.join(" / ") : "-";
}

/** One-line action summary — "AI:persona-1, テンプレ" style. */
export function summarizeActions(rule) {
  const actions = Array.isArray(rule?.actions) ? rule.actions : [];
  if (actions.length === 0) return "(actionなし)";
  return actions.map((action) => {
    if (action.kind === "ai-response") return `AI:${action.personaId || "(未選択)"}`;
    if (action.kind === "overlay-cue") return `Overlay:${[action.cue?.visual && "画像", action.cue?.audio && "音声"].filter(Boolean).join("+") || "(未設定)"}`;
    return "テンプレ発話";
  }).join(", ");
}

/** `{ errors, warnings }` counts from a structured-issue list already filtered to this rule (see
 * views/event-rules.js's own per-rule issue grouping). */
export function summarizeValidation(issues = []) {
  const errors = issues.filter((entry) => entry.severity === "error").length;
  return { errors, warnings: issues.length - errors };
}

/** Every `data.rewardId` value referenced by `rule`'s condition tree that is NOT present in the
 * currently-fetched reward list — "unknown/deleted rewardを...警告表示"'s rule-list-level surface
 * (per-control warnings live in condition-builder.js/reward-selector.js; this is the aggregate used
 * for the list row's badge). Walks both `eq` (single value) and `in` (array value) leaves. */
export function rewardWarningsForRule(rule, rewardsState) {
  const warnings = [];
  function walk(node) {
    if (isConditionGroupNode(node)) {
      const key = Array.isArray(node.all) ? "all" : "any";
      for (const child of node[key] ?? []) walk(child);
      return;
    }
    if (isConditionLeafNode(node) && node.field === "data.rewardId") {
      const values = Array.isArray(node.value) ? node.value : [node.value];
      for (const value of values) if (isUnknownReward(value, rewardsState)) warnings.push(value);
    }
  }
  walk(rule?.condition);
  return warnings;
}

/** `eventTypes` recap for the list row — "cheer, subscription" style, `"(未設定)"` when empty. */
export function summarizeEventTypes(rule) {
  const kinds = Array.isArray(rule?.eventTypes) ? rule.eventTypes : [];
  return kinds.length ? kinds.join(", ") : "(未設定)";
}
