// Issue #95: "AI persona/template/speech/OBS actionを編集" — one editor per ActionConfig #93 already
// defines (src/actions/action-schema.js's `validateActionConfig`/`ACTION_KINDS`), attached to a rule
// as `trigger.actions` (the exact array action-planner.js's `planActions()` already reads — see
// src/simulation/stream-event-simulator.js's own `trigger.actions` read for the same shape).
//
// `speak`/`notifyObs` are NOT part of #93's own ActionConfig contract (action-runner.js's execute()
// currently receives those as CALLER-supplied execution overrides, not persisted config — there is no
// production wiring yet that reads a per-action config value for them, same "no eventTriggers ->
// runtime wiring exists yet" gap this whole rule editor is authoring config ahead of). They are kept
// here anyway, using the exact same field names action-runner.js's `execute(plan, { speak, notifyObs
// })` already accepts, so a future wiring issue has an obvious, ready-to-consume per-action source for
// them instead of inventing its own field names later.
import { ACTION_KINDS, DEFAULT_ACTION_PRIORITY } from "../../actions/action-schema.js";
import { PLACEHOLDER_KEYS } from "../../actions/template-speech-action.js";

const KIND_LABEL = { "ai-response": "AI応答", "template-speech": "テンプレ発話" };

function pathJoin(...parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== "").join(".");
}

let idSeq = 0;
function freshActionId() {
  idSeq += 1;
  return `action-${Date.now().toString(36)}-${idSeq}`;
}

// NOTE: `maxChars`/`timeoutMs` are deliberately OMITTED (not set to `null`) when unset —
// action-schema.js's `validateActionConfig` treats `undefined` as "not present" (fine) but `null`
// as "present but wrong type" (a validation ERROR) — see numberField()'s onChange below, which
// `delete`s the property instead of setting it to `null` when a field is cleared, for the same
// reason.
export function defaultAction(kind = "template-speech") {
  const base = { id: freshActionId(), kind, priority: DEFAULT_ACTION_PRIORITY, speak: true, notifyObs: true };
  return kind === "ai-response" ? { ...base, personaId: "" } : { ...base, template: "" };
}

function numberField(document, { label, value, path, onChange, min }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `));
  const input = document.createElement("input");
  input.type = "number";
  if (min !== undefined) input.min = String(min);
  input.value = value ?? "";
  input.dataset.configPath = path;
  input.addEventListener("input", () => onChange(input.value === "" ? null : Number(input.value)));
  wrap.append(input);
  return wrap;
}

/** Renders ONE action's editor into `root`. `ctx`: `{ path, personaOptions, onStructuralChange,
 * onRemove }` — `personaOptions`: `[{ value: personaId, label: personaName }]` from
 * `config.personas`, matching settings-ui.js's own `#arrSelect("connector", connectorIds, ...)`
 * pattern of sourcing select options straight from sibling config sections. */
export function renderActionEditor(root, action, ctx, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  const { path, personaOptions = [], onStructuralChange, onRemove } = ctx;
  root.replaceChildren();

  // "card"/"card-head"/"card-body" reuse the SAME container vocabulary Settings' connector/persona
  // cards already use (styles/main.css's `.card`/`.card-head`/`.card-body`) — this box's shape
  // (a head row + a body of fields) matches that pattern exactly, so it gets the established
  // bordered-panel chrome and title treatment for free instead of a parallel, one-off CSS block.
  const card = document.createElement("div");
  card.className = "rule-action-card card";

  const head = document.createElement("div");
  head.className = "rule-action-head card-head";
  const kindSelect = document.createElement("select");
  kindSelect.dataset.configPath = pathJoin(path, "kind");
  for (const kind of ACTION_KINDS) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = KIND_LABEL[kind] ?? kind;
    option.selected = kind === action.kind;
    kindSelect.append(option);
  }
  kindSelect.addEventListener("change", () => {
    const fresh = defaultAction(kindSelect.value);
    for (const key of Object.keys(action)) delete action[key];
    Object.assign(action, fresh);
    onStructuralChange();
  });
  head.append(kindSelect);
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "btn-remove";
  removeButton.textContent = "actionを削除";
  removeButton.addEventListener("click", onRemove);
  head.append(removeButton);
  card.append(head);

  const body = document.createElement("div");
  body.className = "rule-action-body card-body";

  if (action.kind === "ai-response") {
    const personaSelect = document.createElement("select");
    personaSelect.dataset.configPath = pathJoin(path, "personaId");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- personaを選択 --";
    placeholder.selected = !action.personaId;
    personaSelect.append(placeholder);
    for (const persona of personaOptions) {
      const option = document.createElement("option");
      option.value = persona.value;
      option.textContent = persona.label;
      option.selected = persona.value === action.personaId;
      personaSelect.append(option);
    }
    if (action.personaId && !personaOptions.some((persona) => persona.value === action.personaId)) {
      const stale = document.createElement("option");
      stale.value = action.personaId;
      stale.textContent = `⚠ ${action.personaId} (personasに存在しません)`;
      stale.selected = true;
      personaSelect.append(stale);
    }
    personaSelect.addEventListener("change", () => { action.personaId = personaSelect.value; });
    const personaLabel = document.createElement("label");
    personaLabel.className = "field-inline";
    personaLabel.append(document.createTextNode("persona: "), personaSelect);
    body.append(personaLabel);
    body.append(numberField(document, { label: "timeoutMs", value: action.timeoutMs, path: pathJoin(path, "timeoutMs"), min: 0, onChange: (value) => { if (value === null) delete action.timeoutMs; else action.timeoutMs = value; } }));
  } else {
    const templateLabel = document.createElement("label");
    templateLabel.className = "field";
    templateLabel.append(document.createTextNode("template"));
    const templateInput = document.createElement("textarea");
    templateInput.rows = 2;
    templateInput.dataset.configPath = pathJoin(path, "template");
    templateInput.value = action.template ?? "";
    templateInput.addEventListener("input", () => { action.template = templateInput.value; });
    templateLabel.append(templateInput);
    body.append(templateLabel);
    const hint = document.createElement("p");
    hint.className = "muted rule-action-template-hint";
    hint.textContent = `利用可能なplaceholder: ${PLACEHOLDER_KEYS.map((key) => `{{${key}}}`).join(" / ")}`;
    body.append(hint);
  }

  body.append(numberField(document, { label: "priority", value: action.priority, path: pathJoin(path, "priority"), onChange: (value) => { action.priority = value ?? DEFAULT_ACTION_PRIORITY; } }));
  body.append(numberField(document, { label: "maxChars", value: action.maxChars, path: pathJoin(path, "maxChars"), min: 1, onChange: (value) => { if (value === null) delete action.maxChars; else action.maxChars = value; } }));

  const toggles = document.createElement("div");
  toggles.className = "rule-action-toggles";
  const speakLabel = document.createElement("label");
  speakLabel.className = "field-inline";
  const speakInput = document.createElement("input");
  speakInput.type = "checkbox";
  speakInput.checked = action.speak !== false;
  speakInput.dataset.configPath = pathJoin(path, "speak");
  speakInput.addEventListener("change", () => { action.speak = speakInput.checked; });
  speakLabel.append(speakInput, document.createTextNode(" 読み上げる"));
  const obsLabel = document.createElement("label");
  obsLabel.className = "field-inline";
  const obsInput = document.createElement("input");
  obsInput.type = "checkbox";
  obsInput.checked = action.notifyObs !== false;
  obsInput.dataset.configPath = pathJoin(path, "notifyObs");
  obsInput.addEventListener("change", () => { action.notifyObs = obsInput.checked; });
  obsLabel.append(obsInput, document.createTextNode(" OBSへ表示"));
  toggles.append(speakLabel, obsLabel);
  body.append(toggles);

  card.append(body);
  root.append(card);
}

/** Renders the WHOLE `trigger.actions` array (live draft array, mutated in place) — add/remove +
 * per-action `renderActionEditor` above. `ctx`: `{ path, personaOptions, onStructuralChange }`. */
export function renderActionList(root, actions, ctx, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  root.className = "rule-action-list";
  const { path, personaOptions = [], onStructuralChange } = ctx;

  if (actions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "actionがありません。追加してください";
    root.append(empty);
  }
  actions.forEach((action, index) => {
    const itemRoot = document.createElement("div");
    renderActionEditor(itemRoot, action, {
      path: pathJoin(path, index),
      personaOptions,
      onStructuralChange,
      onRemove: () => { actions.splice(index, 1); onStructuralChange(); },
    }, document);
    root.append(itemRoot);
  });

  const addRow = document.createElement("div");
  addRow.className = "rule-action-add-row";
  const addTemplate = document.createElement("button");
  addTemplate.type = "button";
  addTemplate.textContent = "＋ テンプレ発話actionを追加";
  addTemplate.addEventListener("click", () => { actions.push(defaultAction("template-speech")); onStructuralChange(); });
  const addAi = document.createElement("button");
  addAi.type = "button";
  addAi.textContent = "＋ AI応答actionを追加";
  addAi.addEventListener("click", () => { actions.push(defaultAction("ai-response")); onStructuralChange(); });
  addRow.append(addTemplate, addAi);
  root.append(addRow);
}
