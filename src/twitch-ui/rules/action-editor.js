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
import {
  MAX_OVERLAY_DURATION_MS, MAX_OVERLAY_HEIGHT, MAX_OVERLAY_QUEUE, MAX_OVERLAY_WIDTH,
  MAX_OVERLAY_Z_INDEX, MIN_OVERLAY_Z_INDEX, OVERLAY_ANCHORS, OVERLAY_EASINGS, OVERLAY_FITS,
  OVERLAY_POLICY_MODES, OVERLAY_TRANSITIONS,
} from "../../overlay/overlay-cue-contract.js";
import {
  DEFAULT_OVERLAY_AUDIO, DEFAULT_OVERLAY_POLICY, DEFAULT_OVERLAY_TIMING,
  DEFAULT_OVERLAY_TRANSITION, DEFAULT_OVERLAY_VISUAL,
} from "../../overlay/overlay-cue-defaults.js";

const KIND_LABEL = { "ai-response": "AI応答", "template-speech": "テンプレ発話", "overlay-cue": "オーバーレイcue" };

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
  const base = { id: freshActionId(), kind, priority: DEFAULT_ACTION_PRIORITY };
  if (kind === "overlay-cue") return { ...base, cue: { visual: { assetId: "overlay-image" } } };
  const speechBase = { ...base, speak: true, notifyObs: true };
  return kind === "ai-response" ? { ...speechBase, personaId: "" } : { ...speechBase, template: "" };
}

function numberField(document, { label, value, path, onChange, min, max, step }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `));
  const input = document.createElement("input");
  input.type = "number";
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.value = value ?? "";
  input.dataset.configPath = path;
  input.addEventListener("input", () => onChange(input.value === "" ? null : Number(input.value)));
  wrap.append(input);
  return wrap;
}

function textField(document, { label, value, path, onChange }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `));
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.dataset.configPath = path;
  input.addEventListener("input", () => onChange(input.value));
  wrap.append(input);
  return wrap;
}

function selectField(document, { label, value, options, path, onChange }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `));
  const select = document.createElement("select");
  select.dataset.configPath = path;
  for (const entry of options) {
    const option = document.createElement("option");
    option.value = entry;
    option.textContent = entry;
    option.selected = entry === value;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  wrap.append(select);
  return wrap;
}

function renderOverlayCueEditor(body, action, { path, onStructuralChange }, document) {
  const cue = action.cue && typeof action.cue === "object" && !Array.isArray(action.cue) ? action.cue : (action.cue = { visual: { assetId: "overlay-image" } });
  const set = (section, field, value) => {
    cue[section] ??= {};
    if (value === null) delete cue[section][field];
    else cue[section][field] = value;
  };
  const sectionTitle = (title) => {
    const heading = document.createElement("h4");
    heading.textContent = title;
    body.append(heading);
  };
  const toggle = (section, label, defaultValue) => {
    const wrap = document.createElement("label");
    wrap.className = "field-inline";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(cue[section]);
    input.dataset.configPath = pathJoin(path, "cue", section);
    input.addEventListener("change", () => {
      if (input.checked) cue[section] = structuredClone(defaultValue);
      else if (section === "visual" && !cue.audio) input.checked = true;
      else if (section === "audio" && !cue.visual) input.checked = true;
      else delete cue[section];
      onStructuralChange();
    });
    wrap.append(input, document.createTextNode(` ${label}`));
    body.append(wrap);
  };

  toggle("visual", "画像を表示", { assetId: "overlay-image" });
  toggle("audio", "音声を再生", { assetId: "overlay-audio" });
  if (cue.visual) {
    sectionTitle("Visual");
    body.append(textField(document, { label: "assetId", value: cue.visual.assetId, path: pathJoin(path, "cue.visual.assetId"), onChange: (value) => set("visual", "assetId", value) }));
    for (const [field, min, max, fallback, step] of [["x", 0, 1, DEFAULT_OVERLAY_VISUAL.x, 0.01], ["y", 0, 1, DEFAULT_OVERLAY_VISUAL.y, 0.01], ["width", 1, MAX_OVERLAY_WIDTH, undefined, 1], ["height", 1, MAX_OVERLAY_HEIGHT, undefined, 1], ["opacity", 0, 1, DEFAULT_OVERLAY_VISUAL.opacity, 0.01], ["zIndex", MIN_OVERLAY_Z_INDEX, MAX_OVERLAY_Z_INDEX, DEFAULT_OVERLAY_VISUAL.zIndex, 1]]) {
      body.append(numberField(document, { label: field, value: cue.visual[field] ?? fallback, path: pathJoin(path, `cue.visual.${field}`), min, max, step, onChange: (value) => set("visual", field, value) }));
    }
    body.append(selectField(document, { label: "anchor", value: cue.visual.anchor ?? DEFAULT_OVERLAY_VISUAL.anchor, options: OVERLAY_ANCHORS, path: pathJoin(path, "cue.visual.anchor"), onChange: (value) => set("visual", "anchor", value) }));
    body.append(selectField(document, { label: "fit", value: cue.visual.fit ?? DEFAULT_OVERLAY_VISUAL.fit, options: OVERLAY_FITS, path: pathJoin(path, "cue.visual.fit"), onChange: (value) => set("visual", "fit", value) }));
  }
  if (cue.audio) {
    sectionTitle("Audio");
    body.append(textField(document, { label: "assetId", value: cue.audio.assetId, path: pathJoin(path, "cue.audio.assetId"), onChange: (value) => set("audio", "assetId", value) }));
    for (const [field, min, max, fallback, step] of [["volume", 0, 1, DEFAULT_OVERLAY_AUDIO.volume, 0.01], ["startDelayMs", 0, MAX_OVERLAY_DURATION_MS, DEFAULT_OVERLAY_AUDIO.startDelayMs, 1], ["fadeInMs", 0, MAX_OVERLAY_DURATION_MS, DEFAULT_OVERLAY_AUDIO.fadeInMs, 1], ["fadeOutMs", 0, MAX_OVERLAY_DURATION_MS, DEFAULT_OVERLAY_AUDIO.fadeOutMs, 1]]) {
      body.append(numberField(document, { label: field, value: cue.audio[field] ?? fallback, path: pathJoin(path, `cue.audio.${field}`), min, max, step, onChange: (value) => set("audio", field, value) }));
    }
  }
  sectionTitle("Timing / transition / policy");
  for (const field of ["enterMs", "holdMs", "exitMs"]) body.append(numberField(document, { label: field, value: cue.timing?.[field] ?? DEFAULT_OVERLAY_TIMING[field], path: pathJoin(path, `cue.timing.${field}`), min: 0, max: MAX_OVERLAY_DURATION_MS, step: 1, onChange: (value) => set("timing", field, value) }));
  body.append(selectField(document, { label: "enter", value: cue.transition?.enter ?? DEFAULT_OVERLAY_TRANSITION.enter, options: OVERLAY_TRANSITIONS, path: pathJoin(path, "cue.transition.enter"), onChange: (value) => set("transition", "enter", value) }));
  body.append(selectField(document, { label: "exit", value: cue.transition?.exit ?? DEFAULT_OVERLAY_TRANSITION.exit, options: OVERLAY_TRANSITIONS, path: pathJoin(path, "cue.transition.exit"), onChange: (value) => set("transition", "exit", value) }));
  body.append(selectField(document, { label: "easing", value: cue.transition?.easing ?? DEFAULT_OVERLAY_TRANSITION.easing, options: OVERLAY_EASINGS, path: pathJoin(path, "cue.transition.easing"), onChange: (value) => set("transition", "easing", value) }));
  body.append(textField(document, { label: "channel", value: cue.policy?.channel ?? DEFAULT_OVERLAY_POLICY.channel, path: pathJoin(path, "cue.policy.channel"), onChange: (value) => set("policy", "channel", value) }));
  body.append(selectField(document, { label: "mode", value: cue.policy?.mode ?? DEFAULT_OVERLAY_POLICY.mode, options: OVERLAY_POLICY_MODES, path: pathJoin(path, "cue.policy.mode"), onChange: (value) => set("policy", "mode", value) }));
  body.append(numberField(document, { label: "maxQueue", value: cue.policy?.maxQueue ?? DEFAULT_OVERLAY_POLICY.maxQueue, path: pathJoin(path, "cue.policy.maxQueue"), min: 1, max: MAX_OVERLAY_QUEUE, step: 1, onChange: (value) => set("policy", "maxQueue", value) }));
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
  } else if (action.kind === "template-speech") {
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
  } else if (action.kind === "overlay-cue") {
    renderOverlayCueEditor(body, action, { path, onStructuralChange }, document);
  }

  body.append(numberField(document, { label: "priority", value: action.priority, path: pathJoin(path, "priority"), onChange: (value) => { action.priority = value ?? DEFAULT_ACTION_PRIORITY; } }));
  if (action.kind !== "overlay-cue") {
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
  }

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
  const addOverlay = document.createElement("button");
  addOverlay.type = "button";
  addOverlay.textContent = "＋ オーバーレイcueを追加";
  addOverlay.addEventListener("click", () => { actions.push(defaultAction("overlay-cue")); onStructuralChange(); });
  addRow.append(addTemplate, addAi, addOverlay);
  root.append(addRow);
}
