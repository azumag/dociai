// Issue #95: event-aware condition builder for the Event Rule editor. Every field/operator option
// shown here comes directly from #91's real registry (src/triggers/event-field-registry.js) — this
// module never hardcodes its own field/operator list, so a future registry change (a new field, a
// new operator) is picked up automatically and a rule can never reference something the registry
// doesn't actually support ("event typeで選択可能field/operatorを絞る"). Save-time correctness is
// still validated by the REAL src/triggers/trigger-validation.js (see views/event-rules.js) — this
// builder only narrows the UI's OWN choices to reduce the chance of authoring something invalid in
// the first place; it is not itself the source of truth for what's valid.
//
// Mutation model: `renderConditionBuilder` renders a LIVE, in-place editor over the actual
// `condition` object living in the caller's draft (mirrors settings-ui.js's own "mutate the draft
// directly on input/change" convention) — a value-only edit (checkbox/number/text keystroke) mutates
// the node in place with no re-render (so focus/caret position survives), while a STRUCTURAL edit
// (add/remove a leaf or group, change a field/operator, swap all<->any) calls `ctx.onStructuralChange()`
// so the owner does a full re-render (the set of controls to show genuinely changed).
import { EVENT_FIELD_KEYS, getFieldDefinition, isFieldValidForAnyKind, operatorsForField } from "../../triggers/event-field-registry.js";
import { CONDITION_GROUP_KEYS, MAX_CONDITION_DEPTH, isConditionGroupNode, isConditionLeafNode } from "../../triggers/event-trigger-schema.js";
import { renderRewardSelector } from "./reward-selector.js";

const OPERATOR_LABEL = {
  eq: "＝", gt: "＞", gte: "≧", lt: "＜", lte: "≦", in: "いずれかに含まれる (in)", between: "範囲内 (between)", contains: "含む (contains)",
};

/** Every registered field valid for AT LEAST ONE of `eventTypes`, in registry order — the exact
 * "event typeで選択可能fieldを絞る" narrowing this issue asks for. Empty `eventTypes` yields an empty
 * option list (nothing to narrow against yet). */
export function fieldOptionsForEventTypes(eventTypes) {
  const kinds = Array.isArray(eventTypes) ? eventTypes : [];
  return EVENT_FIELD_KEYS.filter((key) => isFieldValidForAnyKind(key, kinds)).map((key) => ({ key, ...getFieldDefinition(key) }));
}

/** A sensible default `value` for a freshly chosen (field, operator) pair, keyed off the field's
 * registered value TYPE (never a per-field hardcoded guess) — mirrors trigger-validation.js's own
 * type-driven `validateValueForType`. */
export function defaultValueForFieldOperator(fieldKey, operator) {
  const definition = getFieldDefinition(fieldKey);
  if (!definition) return "";
  if (definition.type === "boolean") return false;
  if (definition.type === "number") {
    if (operator === "in") return [0];
    if (operator === "between") return [0, 0];
    return 0;
  }
  // string
  if (operator === "in") return [""];
  return "";
}

/** A fresh `{field, operator, value}` leaf for `eventTypes` — the first available field (registry
 * order) and its first allowed operator. Returns a `field: null` placeholder leaf when no field
 * applies to any configured event type yet (the operator select renders disabled until a field is
 * chosen). */
export function defaultLeaf(eventTypes) {
  const [first] = fieldOptionsForEventTypes(eventTypes);
  if (!first) return { field: null, operator: null, value: "" };
  const operator = operatorsForField(first.key)[0] ?? null;
  return { field: first.key, operator, value: defaultValueForFieldOperator(first.key, operator) };
}

function pathJoin(prefix, ...parts) {
  return [prefix, ...parts].filter((part) => part !== undefined && part !== null && part !== "").join(".");
}

function setDataPath(element, path) {
  if (path) element.dataset.configPath = path;
}

function parseNumberList(text) {
  return text.split(/[,、]/).map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry));
}
function parseStringList(text) {
  return text.split(/[,、]/).map((entry) => entry.trim()).filter(Boolean);
}

function renderLeafValueControl(root, node, definition, ctx, document) {
  const { path, onValueChange } = ctx;
  const valuePath = pathJoin(path, "value");

  // "reward IDを直接手打ちさせずTwitchの実rewardから選択" — the one field with a dedicated,
  // Helix-backed control instead of a plain text box; every other string/number/boolean field uses
  // a generic control below.
  if (node.field === "data.rewardId" && (node.operator === "eq" || node.operator === "in")) {
    const wrap = document.createElement("div");
    wrap.className = "rule-condition-value rule-condition-value-reward";
    if (node.operator === "eq") {
      renderRewardSelector(wrap, { value: node.value ?? "", rewardsState: ctx.rewardsState, onRefresh: ctx.onRefreshRewards, dataPath: valuePath }, { onChange: (rewardId) => onValueChange(rewardId) }, document);
    } else {
      // "in": a multi-select built from the same fetched reward list, falling back to a
      // comma-separated id list when the fetch hasn't succeeded yet.
      const current = Array.isArray(node.value) ? node.value : [];
      const rewards = ctx.rewardsState?.rewards ?? [];
      if (rewards.length > 0) {
        const select = document.createElement("select");
        select.multiple = true;
        select.size = Math.min(6, Math.max(3, rewards.length));
        setDataPath(select, valuePath);
        for (const reward of rewards) {
          const option = document.createElement("option");
          option.value = reward.id;
          option.textContent = `${reward.title} (${reward.cost}pt)`;
          option.selected = current.includes(reward.id);
          select.append(option);
        }
        for (const id of current) {
          if (!rewards.some((reward) => reward.id === id)) {
            const option = document.createElement("option");
            option.value = id;
            option.textContent = `⚠ 不明な reward (ID: ${id})`;
            option.selected = true;
            select.append(option);
          }
        }
        select.addEventListener("change", () => onValueChange([...select.selectedOptions].map((option) => option.value)));
        wrap.append(select);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.value = current.join(", ");
        input.placeholder = "reward ID をカンマ区切りで入力 (一覧取得後は選択式になります)";
        setDataPath(input, valuePath);
        input.addEventListener("input", () => onValueChange(parseStringList(input.value)));
        wrap.append(input);
      }
    }
    root.append(wrap);
    return;
  }

  if (definition.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = node.value === true;
    setDataPath(input, valuePath);
    input.addEventListener("change", () => onValueChange(input.checked));
    root.append(input);
    return;
  }

  if (definition.type === "number") {
    if (node.operator === "in") {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "数値をカンマ区切り (例: 100, 500, 1000)";
      input.value = Array.isArray(node.value) ? node.value.join(", ") : "";
      setDataPath(input, valuePath);
      input.addEventListener("input", () => onValueChange(parseNumberList(input.value)));
      root.append(input);
      return;
    }
    if (node.operator === "between") {
      const wrap = document.createElement("div");
      wrap.className = "rule-condition-value-range";
      const [min, max] = Array.isArray(node.value) ? node.value : [0, 0];
      const minInput = document.createElement("input");
      minInput.type = "number";
      minInput.value = min ?? 0;
      setDataPath(minInput, valuePath);
      const maxInput = document.createElement("input");
      maxInput.type = "number";
      maxInput.value = max ?? 0;
      const emit = () => onValueChange([Number(minInput.value), Number(maxInput.value)]);
      minInput.addEventListener("input", emit);
      maxInput.addEventListener("input", emit);
      wrap.append(minInput, document.createTextNode(" 〜 "), maxInput);
      root.append(wrap);
      return;
    }
    const input = document.createElement("input");
    input.type = "number";
    input.value = typeof node.value === "number" ? node.value : "";
    setDataPath(input, valuePath);
    input.addEventListener("input", () => onValueChange(input.value === "" ? 0 : Number(input.value)));
    root.append(input);
    return;
  }

  // string
  if (node.operator === "in") {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "文字列をカンマ区切り";
    input.value = Array.isArray(node.value) ? node.value.join(", ") : "";
    setDataPath(input, valuePath);
    input.addEventListener("input", () => onValueChange(parseStringList(input.value)));
    root.append(input);
    return;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.value = typeof node.value === "string" ? node.value : "";
  setDataPath(input, valuePath);
  input.addEventListener("input", () => onValueChange(input.value));
  root.append(input);
}

function renderLeaf(root, node, ctx, document) {
  const { eventTypes, path, onStructuralChange, onRemove } = ctx;
  const row = document.createElement("div");
  row.className = "rule-condition-leaf";

  const options = fieldOptionsForEventTypes(eventTypes);
  const fieldSelect = document.createElement("select");
  setDataPath(fieldSelect, pathJoin(path, "field"));
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.key;
    el.textContent = option.key;
    el.selected = option.key === node.field;
    fieldSelect.append(el);
  }
  if (node.field && !options.some((option) => option.key === node.field)) {
    const stale = document.createElement("option");
    stale.value = node.field;
    stale.textContent = `⚠ ${node.field} (現在のevent typeでは未対応)`;
    stale.selected = true;
    fieldSelect.prepend(stale);
  }
  fieldSelect.addEventListener("change", () => {
    node.field = fieldSelect.value;
    const allowed = operatorsForField(node.field);
    node.operator = allowed[0] ?? null;
    node.value = defaultValueForFieldOperator(node.field, node.operator);
    onStructuralChange();
  });

  const operatorSelect = document.createElement("select");
  setDataPath(operatorSelect, pathJoin(path, "operator"));
  const allowedOperators = node.field ? operatorsForField(node.field) : [];
  for (const operator of allowedOperators) {
    const el = document.createElement("option");
    el.value = operator;
    el.textContent = `${operator} (${OPERATOR_LABEL[operator] ?? operator})`;
    el.selected = operator === node.operator;
    operatorSelect.append(el);
  }
  operatorSelect.disabled = allowedOperators.length === 0;
  operatorSelect.addEventListener("change", () => {
    node.operator = operatorSelect.value;
    node.value = defaultValueForFieldOperator(node.field, node.operator);
    onStructuralChange();
  });

  row.append(fieldSelect, operatorSelect);

  const definition = getFieldDefinition(node.field);
  if (definition) {
    renderLeafValueControl(row, node, definition, { path, rewardsState: ctx.rewardsState, onRefreshRewards: ctx.onRefreshRewards, onValueChange: (value) => { node.value = value; } }, document);
  }

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "btn-remove";
  removeButton.textContent = "条件を削除";
  removeButton.addEventListener("click", onRemove);
  row.append(removeButton);

  root.append(row);
}

function renderGroup(root, node, ctx, document, depth) {
  const { eventTypes, path, onStructuralChange, onRemove } = ctx;
  const groupKey = Array.isArray(node.all) ? "all" : "any";
  const children = node[groupKey];

  const box = document.createElement("div");
  box.className = "rule-condition-group";

  const header = document.createElement("div");
  header.className = "rule-condition-group-header";
  const groupSelect = document.createElement("select");
  setDataPath(groupSelect, path);
  for (const key of CONDITION_GROUP_KEYS) {
    const el = document.createElement("option");
    el.value = key;
    el.textContent = key === "all" ? "すべて満たす (all)" : "いずれか満たす (any)";
    el.selected = key === groupKey;
    groupSelect.append(el);
  }
  groupSelect.addEventListener("change", () => {
    const nextKey = groupSelect.value;
    if (nextKey === groupKey) return;
    node[nextKey] = node[groupKey];
    delete node[groupKey];
    onStructuralChange();
  });
  header.append(groupSelect);

  if (onRemove) {
    const removeGroupButton = document.createElement("button");
    removeGroupButton.type = "button";
    removeGroupButton.className = "btn-remove";
    removeGroupButton.textContent = "グループを削除";
    removeGroupButton.addEventListener("click", onRemove);
    header.append(removeGroupButton);
  }
  box.append(header);

  const childList = document.createElement("div");
  childList.className = "rule-condition-children";
  children.forEach((child, index) => {
    const childPath = pathJoin(path, groupKey, index);
    const childCtx = { ...ctx, path: childPath, onRemove: () => { children.splice(index, 1); onStructuralChange(); } };
    renderConditionNode(childList, child, childCtx, document, depth + 1);
  });
  box.append(childList);

  const actions = document.createElement("div");
  actions.className = "rule-condition-actions";
  const addLeafButton = document.createElement("button");
  addLeafButton.type = "button";
  addLeafButton.textContent = "＋ 条件を追加";
  addLeafButton.addEventListener("click", () => { children.push(defaultLeaf(eventTypes)); onStructuralChange(); });
  actions.append(addLeafButton);
  if (depth < MAX_CONDITION_DEPTH - 1) {
    const addGroupButton = document.createElement("button");
    addGroupButton.type = "button";
    addGroupButton.textContent = "＋ グループを追加";
    addGroupButton.addEventListener("click", () => { children.push({ all: [] }); onStructuralChange(); });
    actions.append(addGroupButton);
  }
  box.append(actions);

  root.append(box);
}

function renderConditionNode(root, node, ctx, document, depth = 0) {
  if (isConditionGroupNode(node)) { renderGroup(root, node, ctx, document, depth); return; }
  if (isConditionLeafNode(node)) { renderLeaf(root, node, ctx, document); return; }
  // Malformed/legacy shape (shouldn't happen via this UI, but a hand-edited config file could have
  // one) — show it as an inert warning rather than crashing the whole rule editor.
  const warning = document.createElement("p");
  warning.className = "rule-condition-invalid muted";
  warning.textContent = "この条件ノードは不明な形式です (JSON編集で作成された可能性があります)";
  root.append(warning);
}

/**
 * Renders the FULL condition tree editor over `condition` (the live draft object — mutated in
 * place). `ctx`: `{ eventTypes, path, onStructuralChange, rewardsState, onRefreshRewards }`.
 * `path` is the `data-config-path` PREFIX for this tree (e.g. `eventTriggers.rule-1.condition`),
 * matching trigger-validation.js's own issue path shape exactly so a validation error can be
 * navigated straight to the offending control (see views/event-rules.js's focus-on-issue).
 */
export function renderConditionBuilder(root, condition, ctx, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  renderConditionNode(root, condition, { ...ctx, onRemove: null }, document, 0);
}
