// Issue #96: a quick, immediate summary of the LAST simulation run — matched/skipped counts, one
// line per plan, and a link into the SAME trace drawer views/event-history.js already renders (this
// module deliberately does not re-render the full matcher/budget/plan/execution/prompt-preview
// detail a second time — see src/twitch-ui/history/trigger-trace-drawer.js, which every simulation
// run is ALSO recorded into via EventHistoryStore#recordSimulation(), so "open in Event History" is
// never a dead end).
import { formatStreamEvent } from "../../stream-events/display.js";
import { collectApiKeys, scrubSecrets } from "../../security.js";

const STATUS_LABEL = { pending: "保留中", handled: "処理済み", skipped: "スキップ", failed: "失敗" };

function safeFormat(event) {
  try {
    return formatStreamEvent(event);
  } catch {
    return { icon: "❔", label: "不明", summary: "", value: 0 };
  }
}

/**
 * `entry`: the `EventHistoryStore` entry `EventHistoryStore#recordSimulation()` just returned (or
 * `null` before the first run). `callbacks`: `{ onOpenTrace(entryId), getConfig }`.
 */
export function renderSimulationResult(root, entry, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  if (!entry) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "まだ実行していません";
    root.append(empty);
    return;
  }

  const keys = (() => {
    try {
      return collectApiKeys(callbacks.getConfig?.() ?? {});
    } catch {
      return [];
    }
  })();
  const scrub = (text) => scrubSecrets(text ?? "", keys);

  const display = safeFormat(entry.event);
  const status = document.createElement("p");
  status.className = `simulation-result-status is-${entry.status}`;
  status.setAttribute("aria-live", "polite");
  status.textContent = `${display.icon} ${scrub(display.summary)} — ${STATUS_LABEL[entry.status] ?? entry.status} (context: ${entry.context})`;
  root.append(status);

  if (entry.trace?.ok === false) {
    const issues = document.createElement("ul");
    for (const issue of entry.trace.issues ?? []) {
      const item = document.createElement("li");
      item.textContent = `${issue.path?.join(".") ?? ""}: ${issue.message}`;
      issues.append(item);
    }
    root.append(issues);
  } else {
    const matches = entry.trace?.matches ?? [];
    const skipped = entry.trace?.skipped ?? [];
    const summary = document.createElement("p");
    summary.textContent = `マッチ: ${matches.length}件 / スキップ: ${skipped.length}件 / plan: ${entry.trace?.plans?.length ?? 0}件 / 実行: ${entry.trace?.results?.length ?? 0}件`;
    root.append(summary);
  }

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.dataset.simulationOpenTrace = entry.id;
  openButton.textContent = "Event Historyで詳細を見る (trace drawer)";
  openButton.addEventListener("click", () => callbacks.onOpenTrace?.(entry.id));
  root.append(openButton);
}
