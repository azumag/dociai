// Issue #96: "trace drawerへnormalized event、matcher、budget、plan、executionを表示" +
// "prompt previewをtrusted/untrusted区分付きで表示". Renders ONE history entry
// (src/twitch-ui/history/history-store.js's `EventHistoryEntry`) in full detail — this is the ONLY
// place in this UI a message's/userInput's actual (sanitized, quoted) text is ever shown; the row
// list (views/event-history.js) keeps it collapsed by default.
//
// The prompt preview is built HERE, on render, directly from the entry's own real `trace.plans`
// (never a second/duplicated prompt-building path) via `buildStreamEventContext()` — the EXACT
// system/user two-message structure #93's ai-response action actually sends, including the
// clearly-delimited untrusted block, so an operator can visually confirm the injection defense is
// live (see src/context/stream-event-context.js's own header comment for the structure itself).
//
// Defense-in-depth: every free-text value rendered here (summary text, prompt messages, execution
// result text, error messages) is passed through security.js's REAL `scrubSecrets()`/
// `collectApiKeys()` — reused, not reimplemented — against the CURRENT config's own known secret
// fields, even though neither a StreamEvent (#89) nor `buildStreamEventContext()` (#93) ever puts a
// secret into this data in the first place (see this issue's own PR body for why this layer exists
// anyway).
import { formatStreamEvent } from "../../stream-events/display.js";
import { buildStreamEventContext } from "../../context/stream-event-context.js";
import { collectApiKeys, scrubSecrets } from "../../security.js";

const STATUS_LABEL = { pending: "保留中 (未評価)", handled: "処理済み", skipped: "スキップ", failed: "失敗" };
const CONTEXT_LABEL = { production: "本番", simulation: "シミュレーション" };

function scrubberFor(getConfig) {
  let keys = null;
  return (text) => {
    if (keys === null) {
      try {
        keys = collectApiKeys(getConfig?.() ?? {});
      } catch {
        keys = [];
      }
    }
    return scrubSecrets(text ?? "", keys);
  };
}

function safeFormat(event) {
  try {
    return formatStreamEvent(event);
  } catch {
    return { icon: "❔", label: "不明", summary: "", value: 0 };
  }
}

function section(document, titleText) {
  const box = document.createElement("section");
  box.className = "trace-drawer-section";
  const heading = document.createElement("h4");
  heading.textContent = titleText;
  box.append(heading);
  return box;
}

function definitionList(document, pairs) {
  const dl = document.createElement("dl");
  dl.className = "trace-drawer-fields";
  for (const [label, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    dl.append(dt, dd);
  }
  return dl;
}

/** Renders the NORMALIZED StreamEvent — structured fields only (this repo's own StreamEvent
 * contract already guarantees no raw platform payload can reach here at all, see
 * src/stream-events/contract.js's `findRawPayloadLeaks()`), never a flattened prompt/JSON dump. */
function renderNormalizedEvent(document, event, scrub) {
  const box = section(document, "正規化イベント (normalized event)");
  const display = safeFormat(event);
  const summary = document.createElement("p");
  summary.className = "trace-drawer-summary";
  summary.textContent = scrub(`${display.icon} ${display.summary}`);
  box.append(summary);
  box.append(definitionList(document, [
    ["kind", event?.kind],
    ["id", event?.id],
    ["timestamp", event?.timestamp],
    ["actor", event?.actor?.isAnonymous ? "匿名" : event?.actor?.displayName],
    ["channel", event?.channel?.displayName],
  ]));
  return box;
}

// A condition's `actual`/`expected` values come straight from live StreamEvent field values (e.g.
// `data.message`/`data.userInput`), so they carry the SAME secret-leak risk as the untrusted text
// rendered elsewhere in this drawer — a viewer-typed cheer/redemption message could contain a
// pasted API key, and this row must scrub it exactly like every other rendered surface does.
function renderConditionDetails(document, details, scrub) {
  const list = document.createElement("ul");
  list.className = "trace-condition-details";
  for (const detail of details ?? []) {
    const item = document.createElement("li");
    item.className = detail.passed ? "is-pass" : "is-fail";
    const expected = scrub(JSON.stringify(detail.expected));
    const actual = scrub(JSON.stringify(detail.actual));
    item.textContent = `${detail.field ?? "?"} ${detail.operator ?? "?"} ${expected} — 実際値: ${actual} (${detail.passed ? "一致" : detail.reason ?? "不一致"})`;
    list.append(item);
  }
  return list;
}

/** "matcher" — every trigger this event was evaluated against, matched AND skipped, with the full
 * per-leaf condition trace (#91's real MatchResult shape) — WHY a rule matched or didn't. */
function renderMatcherSection(document, trace, scrub) {
  const box = section(document, "Matcher (rule評価結果)");
  const matches = trace?.matches ?? [];
  const skipped = trace?.skipped ?? [];
  if (matches.length === 0 && skipped.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "評価されたruleはありません";
    box.append(empty);
    return box;
  }
  for (const match of matches) {
    const row = document.createElement("div");
    row.className = "trace-match-row is-matched";
    const title = document.createElement("p");
    title.textContent = `✓ マッチ: ${match.triggerId} (priority ${match.priority}${match.stopPropagation ? ", stopPropagation" : ""})`;
    row.append(title, renderConditionDetails(document, match.details, scrub));
    box.append(row);
  }
  for (const skip of skipped) {
    const row = document.createElement("div");
    row.className = "trace-match-row is-skipped";
    const title = document.createElement("p");
    title.textContent = `✗ スキップ: ${skip.triggerId} — 理由: ${skip.reason ?? "不明"}`;
    row.append(title, renderConditionDetails(document, skip.details, scrub));
    box.append(row);
  }
  return box;
}

/** "budget" — every cooldown/rate-limit/global-budget/max-actions-per-trigger reason a plan or
 * execution attempt was skipped for (action-planner.js's `planSkips` + action-runner.js's own
 * execution-time skip `reason`s) — kept as its own section since these are DISTINCT from "the
 * condition tree didn't match" (the matcher section above). */
function renderBudgetSection(document, trace) {
  const box = section(document, "Budget / Cooldown / Rate limit");
  const planSkips = trace?.planSkips ?? [];
  const executionSkips = (trace?.results ?? []).filter((entry) => entry.status === "skipped");
  if (planSkips.length === 0 && executionSkips.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "budget/cooldownによるスキップはありません";
    box.append(empty);
    return box;
  }
  const list = document.createElement("ul");
  for (const skip of planSkips) {
    const item = document.createElement("li");
    item.textContent = `plan構築時: trigger=${skip.triggerId ?? "?"} action[${skip.actionIndex}] — ${skip.reason}`;
    list.append(item);
  }
  for (const skip of executionSkips) {
    const item = document.createElement("li");
    item.textContent = `実行時: trigger=${skip.triggerId ?? "?"} plan=${skip.planId ?? "?"} — ${skip.reason}`;
    list.append(item);
  }
  box.append(list);
  return box;
}

/** "plan" — every ActionPlan #93's action-planner.js built from a match (kind/persona-or-template/
 * priority), independent of whether it was ever executed. */
function renderPlanSection(document, trace) {
  const box = section(document, "Plan (構築されたaction)");
  const plans = trace?.plans ?? [];
  if (plans.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "構築されたplanはありません";
    box.append(empty);
    return box;
  }
  const list = document.createElement("ul");
  for (const plan of plans) {
    const item = document.createElement("li");
    item.textContent = plan.kind === "ai-response"
      ? `AI応答 — persona: ${plan.action?.personaId ?? "(未設定)"} (priority ${plan.priority})`
      : `テンプレ発話 — template: "${plan.action?.template ?? ""}" (priority ${plan.priority})`;
    list.append(item);
  }
  box.append(list);
  return box;
}

/** "execution" — the real ActionRunner.execute() result per plan (status/text/error), when this
 * simulation actually ran an ActionRunner (`options.actionRunner` was supplied — see
 * views/simulation.js); an empty `results` list (the safe-preview default: matcher/planner only,
 * no execution) is shown as its own explicit state, never confused with "nothing happened". */
function renderExecutionSection(document, trace, scrub) {
  const box = section(document, "Execution (実行結果)");
  const results = trace?.results ?? [];
  if (results.length === 0) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = plansWereBuiltButNotExecuted(trace) ? "planは構築されましたが、実行 (ActionRunner) は行われていません (安全なpreviewのみ)" : "実行結果はありません";
    box.append(note);
    return box;
  }
  const list = document.createElement("ul");
  for (const result of results) {
    const item = document.createElement("li");
    item.className = `trace-execution-row is-${result.status}`;
    const label = STATUS_LABEL[result.status] ?? result.status;
    const text = result.text ? ` — "${scrub(result.text)}"` : "";
    const error = result.error?.message ? ` (error: ${scrub(result.error.message)})` : "";
    const reason = result.reason ? ` (理由: ${result.reason})` : "";
    item.textContent = `${label}${text}${reason}${error}`;
    list.append(item);
  }
  box.append(list);
  return box;
}

function plansWereBuiltButNotExecuted(trace) {
  return (trace?.plans?.length ?? 0) > 0;
}

/** Resolves the persona `action.personaId` refers to via `getConfig()?.personas` — mirrors
 * views/event-rules.js's own `#personaOptions()` persona lookup convention (id-keyed, config-driven,
 * never a hardcoded list). Returns `null` (never throws) when unresolvable — `buildStreamEventContext`
 * itself tolerates a null persona (falls back to an empty systemPrompt), so a missing persona still
 * renders a (degraded but honest) preview instead of skipping the section outright. */
function resolvePersona(getConfig, personaId) {
  try {
    const personas = getConfig?.()?.personas ?? [];
    return personas.find((persona) => persona.id === personaId) ?? null;
  } catch {
    return null;
  }
}

/** "prompt previewをtrusted/untrusted区分付きで表示" — renders `buildStreamEventContext()`'s REAL
 * `messages` array (system message = trusted-only; user message = trusted task description +, when
 * present, the untrusted quoted block) for every `ai-response` plan in `trace.plans`, computed live
 * from the plan's own `action`/`event` (never a cached/stale copy). */
function renderPromptPreviewSection(document, trace, getConfig, scrub) {
  const box = section(document, "Prompt Preview (trusted / untrusted)");
  const aiPlans = (trace?.plans ?? []).filter((plan) => plan.kind === "ai-response");
  if (aiPlans.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "AI応答planがないためpromptはありません";
    box.append(empty);
    return box;
  }
  for (const plan of aiPlans) {
    const persona = resolvePersona(getConfig, plan.action?.personaId);
    let built;
    try {
      built = buildStreamEventContext({ persona, event: plan.event, action: plan.action });
    } catch {
      built = null;
    }
    const planBox = document.createElement("div");
    planBox.className = "trace-prompt-plan";
    const heading = document.createElement("p");
    heading.className = "trace-prompt-plan-heading";
    heading.textContent = `persona: ${plan.action?.personaId ?? "(未設定)"}${built?.untrustedIncluded ? "（untrustedテキストを含む）" : ""}`;
    planBox.append(heading);
    if (!built) {
      const failed = document.createElement("p");
      failed.className = "muted";
      failed.textContent = "promptを構築できませんでした";
      planBox.append(failed);
    } else {
      for (const message of built.messages) {
        // Split into a small colored "eyebrow" label + the message body, rather than one plain
        // <pre> blob — issue #93's injection defense (trusted system prompt vs. task+quoted-
        // untrusted user message) is this drawer's own core safety mechanism made visible, so the
        // trusted/untrusted split deserves to actually READ as two distinct kinds of content (see
        // styles/main.css's `.trace-prompt-message.is-system`/`.is-user`), not just two paragraphs
        // of identically-styled text. `root.textContent` (what SECURITY tests scan for the literal
        // "USER (task"/"SYSTEM (trusted" label text and for secret-leak absence) is unaffected —
        // splitting into two child elements doesn't remove any text, only how it's grouped.
        const messageBox = document.createElement("div");
        messageBox.className = `trace-prompt-message is-${message.role}`;
        messageBox.dataset.promptRole = message.role;
        const roleLabel = message.role === "system" ? "SYSTEM (trusted設定のみ)" : "USER (task + 引用untrustedテキスト)";
        const roleEyebrow = document.createElement("p");
        roleEyebrow.className = "trace-prompt-role";
        roleEyebrow.textContent = `[${roleLabel}]`;
        const bodyPre = document.createElement("pre");
        bodyPre.className = "trace-prompt-body";
        bodyPre.textContent = scrub(message.content);
        messageBox.append(roleEyebrow, bodyPre);
        planBox.append(messageBox);
      }
    }
    box.append(planBox);
  }
  return box;
}

/**
 * Renders the full trace drawer for one history entry. `entry`: an `EventHistoryStore`
 * `EventHistoryEntry`. `ctx`: `{ onClose, getConfig }`. Pure DOM-producing function — no focus
 * management (the caller, views/event-history.js, owns save/restore-focus around open/close, per
 * this issue's own "focus restoration" requirement) and no side effects beyond building the tree and
 * registering the close-button listener.
 */
export function renderTriggerTraceDrawer(root, entry, ctx = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  if (!entry) return;
  const scrub = scrubberFor(ctx.getConfig);

  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Trigger trace 詳細");

  const head = document.createElement("div");
  head.className = "trace-drawer-head";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "trace-drawer-close";
  closeButton.textContent = "← 一覧へ戻る";
  closeButton.addEventListener("click", () => ctx.onClose?.());
  head.append(closeButton);
  root.append(head);

  const status = document.createElement("p");
  status.className = `trace-drawer-status is-${entry.status}`;
  status.setAttribute("aria-live", "polite");
  status.textContent = `${CONTEXT_LABEL[entry.context] ?? entry.context} / ${STATUS_LABEL[entry.status] ?? entry.status}`;
  root.append(status);

  root.append(renderNormalizedEvent(document, entry.event, scrub));

  if (!entry.trace) {
    const pending = document.createElement("p");
    pending.className = "muted";
    pending.textContent = "このイベントはまだtrigger評価されていません (pending)";
    root.append(pending);
    return;
  }

  if (entry.trace.ok === false) {
    const box = section(document, "検証エラー");
    const list = document.createElement("ul");
    for (const issue of entry.trace.issues ?? []) {
      const item = document.createElement("li");
      item.textContent = `${issue.path?.join(".") ?? ""}: ${issue.message}`;
      list.append(item);
    }
    box.append(list);
    root.append(box);
    return;
  }

  root.append(renderMatcherSection(document, entry.trace, scrub));
  root.append(renderBudgetSection(document, entry.trace));
  root.append(renderPlanSection(document, entry.trace));
  root.append(renderExecutionSection(document, entry.trace, scrub));
  root.append(renderPromptPreviewSection(document, entry.trace, ctx.getConfig, scrub));
}
