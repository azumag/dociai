// Issue #96: "production/simulation、type、result、text filterを実装" — pure filter functions over
// `EventHistoryStore#list()`'s entries, kept standalone (no DOM, no store coupling) for direct unit
// testing, mirroring src/twitch-ui/rules/rule-summary.js's own "pure formatting/derivation, no DOM"
// split from its rendering counterpart.
import { formatStreamEvent } from "../../stream-events/display.js";

export const HISTORY_CONTEXT_FILTERS = Object.freeze(["all", "production", "simulation"]);
export const HISTORY_RESULT_FILTERS = Object.freeze(["all", "pending", "handled", "skipped", "failed"]);

export function createHistoryFilterState(overrides = {}) {
  return { context: "all", type: "all", result: "all", text: "", ...overrides };
}

/** A single lowercase haystack for the text filter — built from safely-DISPLAYABLE fields only
 * (formatStreamEvent()'s own icon/label/summary, which already includes a kind's one free-text
 * field folded into a formatted, non-raw summary string — see display.js's own FORMATTERS — plus
 * actor/channel display names, event kind, and triggerId). Never includes
 * `event.data.message`/`data.userInput` directly/unformatted — this mirrors the row list's own
 * "collapse untrusted text by default" stance: a filter match happens against the SAME text a row
 * already shows, never against text the row itself keeps hidden. */
function searchableText(entry) {
  const display = safeFormat(entry.event);
  const parts = [
    display.label,
    display.summary,
    entry.event?.kind,
    entry.event?.actor?.displayName,
    entry.event?.channel?.displayName,
    ...(entry.trace?.matches ?? []).map((match) => match.triggerId),
    ...(entry.trace?.skipped ?? []).map((match) => match.triggerId),
  ];
  return parts.filter(Boolean).join(" \n ").toLowerCase();
}

function safeFormat(event) {
  try {
    return formatStreamEvent(event);
  } catch {
    return { icon: "❔", label: "", summary: "", value: 0 };
  }
}

/** Filters `entries` (EventHistoryStore#list() order, oldest-first) by
 * `{ context, type, result, text }`. Any field left at its `"all"`/empty default is not applied.
 * Never mutates or reorders beyond removing non-matching entries. */
export function filterHistoryEntries(entries, filters = {}) {
  const { context = "all", type = "all", result = "all", text = "" } = filters;
  const needle = text.trim().toLowerCase();
  return (entries ?? []).filter((entry) => {
    if (context !== "all" && entry.context !== context) return false;
    if (type !== "all" && entry.event?.kind !== type) return false;
    if (result !== "all" && entry.status !== result) return false;
    if (needle && !searchableText(entry).includes(needle)) return false;
    return true;
  });
}
