// Issue #95: "rule listへenabled/name/event/condition/priority/budget/action/validationを表示" +
// "create/clone/delete/reorderを実装". A rule list row is intentionally driven by the EXACT same
// `priority` field src/triggers/event-trigger-matcher.js sorts by at match time (higher fires
// first) — "reorder" here means REAL reordering of match-time evaluation order, not a cosmetic
// list-only order, so moving a rule up/down in this list has an observable runtime effect.
import { rewardWarningsForRule, summarizeActions, summarizeBudget, summarizeCondition, summarizeEventTypes, summarizeValidation } from "./rule-summary.js";

/** `[{ id, rule, index }]`, sorted the SAME way event-trigger-matcher.js's own
 * `stableSortByPriorityDesc` orders triggers for matching (priority descending, ties broken by
 * original insertion order) — so this list's visual order always matches real evaluation order. */
export function orderRules(rulesById) {
  return Object.entries(rulesById ?? {})
    .map(([id, rule], index) => ({ id, rule, index }))
    .sort((a, b) => (b.rule?.priority ?? 0) - (a.rule?.priority ?? 0) || a.index - b.index);
}

/** Moves `id` one step up/down in match-time evaluation order by adjusting `priority` in place
 * (mutates the rule objects inside `rulesById` — same "mutate the draft directly" convention as
 * condition-builder.js). Swaps priorities with the neighbor when they already differ; bumps the
 * moved rule's priority by 1 past the neighbor when they're tied (so two same-priority rules don't
 * just swap positions right back on the very next matcher tie-break). Returns `true` iff a move
 * happened (false at either end of the list). */
export function movePriority(rulesById, id, direction) {
  const ordered = orderRules(rulesById);
  const pos = ordered.findIndex((entry) => entry.id === id);
  if (pos < 0) return false;
  const targetPos = direction === "up" ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= ordered.length) return false;
  const moved = ordered[pos].rule;
  const neighbor = ordered[targetPos].rule;
  const movedPriority = moved.priority ?? 0;
  const neighborPriority = neighbor.priority ?? 0;
  if (movedPriority === neighborPriority) {
    moved.priority = direction === "up" ? neighborPriority + 1 : neighborPriority - 1;
  } else {
    moved.priority = neighborPriority;
    neighbor.priority = movedPriority;
  }
  return true;
}

function cell(document, text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

/**
 * `props`: `{ rulesById, selectedId, rewardsState, issuesByRuleId }` (`issuesByRuleId`: `{ [id]:
 * StructuredIssue[] }`, already grouped by views/event-rules.js).
 * `callbacks`: `{ onSelect, onCreate, onClone, onDelete, onMoveUp, onMoveDown, onToggleEnabled, onTest }`.
 */
export function renderRuleList(root, props = {}, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const { rulesById = {}, selectedId = null, rewardsState = { status: "idle", rewards: [] }, issuesByRuleId = {} } = props;

  const header = document.createElement("div");
  header.className = "list-header";
  const title = document.createElement("h3");
  title.textContent = "Event Rule 一覧";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "btn-add";
  addButton.dataset.ruleListAdd = "true";
  addButton.textContent = "＋ 新規Ruleを追加";
  addButton.addEventListener("click", () => callbacks.onCreate?.());
  header.append(title, addButton);
  root.append(header);

  const ordered = orderRules(rulesById);
  if (ordered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Event Ruleがありません。「＋ 新規Ruleを追加」で作成してください";
    root.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "rule-list-table";
  const headRow = document.createElement("tr");
  for (const label of ["有効", "名前 / ID", "event", "条件", "priority", "budget", "action", "検証", "操作"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  table.append(headRow);

  ordered.forEach(({ id, rule }, position) => {
    const row = document.createElement("tr");
    row.dataset.ruleId = id;
    row.className = id === selectedId ? "is-selected" : "";

    const enabledTd = document.createElement("td");
    const enabledCb = document.createElement("input");
    enabledCb.type = "checkbox";
    enabledCb.checked = rule.enabled !== false;
    enabledCb.dataset.configPath = `eventTriggers.${id}.enabled`;
    enabledCb.addEventListener("change", () => callbacks.onToggleEnabled?.(id, enabledCb.checked));
    enabledTd.append(enabledCb);
    row.append(enabledTd);

    const nameTd = document.createElement("td");
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "rule-list-name-link";
    nameButton.textContent = rule.name ? `${rule.name} (${id})` : id;
    nameButton.addEventListener("click", () => callbacks.onSelect?.(id));
    nameTd.append(nameButton);
    row.append(nameTd);

    row.append(cell(document, summarizeEventTypes(rule)));
    row.append(cell(document, summarizeCondition(rule.condition), "rule-list-condition"));
    row.append(cell(document, String(rule.priority ?? 0)));
    row.append(cell(document, summarizeBudget(rule)));
    row.append(cell(document, summarizeActions(rule)));

    const validationTd = document.createElement("td");
    const { errors, warnings } = summarizeValidation(issuesByRuleId[id] ?? []);
    const rewardWarnings = rewardWarningsForRule(rule, rewardsState);
    if (errors > 0) {
      const badge = document.createElement("span");
      badge.className = "rule-list-badge is-error";
      badge.textContent = `エラー ${errors}`;
      validationTd.append(badge);
    }
    if (warnings > 0) {
      const badge = document.createElement("span");
      badge.className = "rule-list-badge is-warning";
      badge.textContent = `警告 ${warnings}`;
      validationTd.append(badge);
    }
    if (rewardWarnings.length > 0) {
      const badge = document.createElement("span");
      badge.className = "rule-list-badge is-warning";
      badge.title = rewardWarnings.join(", ");
      badge.textContent = `⚠ 不明なreward ${rewardWarnings.length}件`;
      validationTd.append(badge);
    }
    if (errors === 0 && warnings === 0 && rewardWarnings.length === 0) {
      const ok = document.createElement("span");
      ok.className = "rule-list-badge is-ok";
      ok.textContent = "OK";
      validationTd.append(ok);
    }
    row.append(validationTd);

    const opsTd = document.createElement("td");
    opsTd.className = "rule-list-ops";
    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.textContent = "↑";
    upButton.title = "優先度を上げる (評価順を上げる)";
    upButton.disabled = position === 0;
    upButton.addEventListener("click", () => callbacks.onMoveUp?.(id));
    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.textContent = "↓";
    downButton.title = "優先度を下げる (評価順を下げる)";
    downButton.disabled = position === ordered.length - 1;
    downButton.addEventListener("click", () => callbacks.onMoveDown?.(id));
    const cloneButton = document.createElement("button");
    cloneButton.type = "button";
    cloneButton.textContent = "複製";
    cloneButton.addEventListener("click", () => callbacks.onClone?.(id));
    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.textContent = "テスト実行";
    testButton.addEventListener("click", () => callbacks.onTest?.(id));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "btn-remove";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => callbacks.onDelete?.(id));
    opsTd.append(upButton, downButton, cloneButton, testButton, deleteButton);
    row.append(opsTd);

    table.append(row);
  });
  root.append(table);
}
