const STORAGE_KEY = "dociai.politics-rundown.v1";
const SCHEMA_VERSION = 1;

const $ = (id) => document.getElementById(id);
const uid = () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const today = () => new Date().toLocaleDateString("sv-SE");

function createCue(label = "読み上げ", text = "") {
  return { id: uid(), label, speakerLabel: "AI", text };
}

function createSlide(overrides = {}) {
  return {
    id: uid(),
    section: "重大ニュース",
    kicker: "TOPIC",
    title: "新しいスライド",
    subtitle: "",
    bullets: [],
    sources: [],
    notes: "",
    cues: [createCue()],
    ...overrides,
  };
}

function createDefaultRundown() {
  const slides = [
    createSlide({
      section: "オープニング",
      kicker: "POLITICS & ECONOMY",
      title: "政経ニュースコーナー",
      subtitle: "重大ニュースと、その周辺で起きた『おいおい』な話",
      bullets: ["重大ニュース 3本", "周辺こぼれ話", "今日のまとめ"],
      notes: "出演者紹介や掛け合いは後から追加する。まず番組の入口として使用。",
      cues: [createCue("オープニング", "政経ニュースコーナーを始めます。まずは、今日押さえておきたい三つの大きな話題です。")],
    }),
    createSlide({
      section: "重大ニュース 1",
      kicker: "MIDDLE EAST",
      title: "中東情勢",
      subtitle: "戦争・外交・原油価格が日本にもつながる",
      bullets: ["何が起きたか", "各国の狙い", "エネルギーと日本への影響"],
      notes: "最新状況を調査後、具体的な国名・日付・地図・数値へ差し替える。",
      cues: [createCue("導入", "最初の重大ニュースは中東情勢です。戦場の動きだけでなく、原油価格や日本経済への影響まで見ます。")],
    }),
    createSlide({
      section: "重大ニュース 2",
      kicker: "US / JAPAN ECONOMY",
      title: "米国と日本経済",
      subtitle: "金利・為替・物価は、どこまで生活に響くのか",
      bullets: ["米国経済と金融政策", "円相場と日本の物価", "家計・企業・株式市場への波及"],
      notes: "為替・金利・市場データは放送直前に更新する。",
      cues: [createCue("導入", "続いては米国と日本の経済です。数字の話に見えますが、物価や住宅ローン、投資に直結します。")],
    }),
    createSlide({
      section: "重大ニュース 3",
      kicker: "CONSUMPTION TAX",
      title: "消費税をどうするのか",
      subtitle: "減税・財源・社会保障・事業者負担を分けて考える",
      bullets: ["現在出ている案", "家計への効果", "財源と制度変更コスト"],
      notes: "政党・政府案が複数ある場合は混同せず、提案主体と期間を明記する。",
      cues: [createCue("導入", "三つ目は消費税です。減税という言葉だけでなく、対象、期間、財源、実務負担を分けて確認します。")],
    }),
    createSlide({
      section: "こぼれ話",
      kicker: "SIDE STORIES",
      title: "政治と行政の『おいおい』",
      subtitle: "失言、迷走、演出、警察・行政の不祥事を短く確認",
      bullets: ["政治家のやらかし", "首相・政党の迷走", "警察・行政のやらかし"],
      notes: "1件30〜60秒。単なる嘲笑で終わらず、背景や権力構造を一言添える。",
      cues: [createCue("コーナー導入", "ここからは周辺こぼれ話です。重大ニュースほどではないけれど、その国の政治文化がよく見える話をまとめます。")],
    }),
    createSlide({
      section: "まとめ",
      kicker: "TAKEAWAY",
      title: "今日、何を見ておくべきか",
      subtitle: "次に動く数字・政策・日程を確認して終了",
      bullets: ["今後の注目日程", "日本への影響", "生活者として見るポイント"],
      notes: "次回までに追う項目を3つ以内に絞る。",
      cues: [createCue("締め", "以上、今日の政経ニュースでした。最後に、次に動きそうなポイントを確認して終わります。")],
    }),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    title: "政経ニュースコーナー",
    airDate: today(),
    currentSlideId: slides[0].id,
    voicevox: { baseUrl: "http://127.0.0.1:50021", speaker: 3, speedScale: 1.0 },
    slides,
  };
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return [];
}

function normalizeCue(value) {
  return {
    id: typeof value?.id === "string" && value.id ? value.id : uid(),
    label: String(value?.label ?? "読み上げ"),
    speakerLabel: String(value?.speakerLabel ?? "AI"),
    text: String(value?.text ?? ""),
  };
}

function normalizeSlide(value) {
  return createSlide({
    id: typeof value?.id === "string" && value.id ? value.id : uid(),
    section: String(value?.section ?? "重大ニュース"),
    kicker: String(value?.kicker ?? "TOPIC"),
    title: String(value?.title ?? "無題"),
    subtitle: String(value?.subtitle ?? ""),
    bullets: normalizeStringArray(value?.bullets),
    sources: normalizeStringArray(value?.sources),
    notes: String(value?.notes ?? ""),
    cues: Array.isArray(value?.cues) ? value.cues.map(normalizeCue) : [],
  });
}

function normalizeRundown(value) {
  if (!value || typeof value !== "object") throw new Error("番組データがJSONオブジェクトではありません");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error(`未対応のschemaVersionです: ${value.schemaVersion ?? "なし"}`);
  const slides = Array.isArray(value.slides) ? value.slides.map(normalizeSlide) : [];
  if (slides.length === 0) throw new Error("スライドが1枚もありません");
  const currentSlideId = slides.some((slide) => slide.id === value.currentSlideId) ? value.currentSlideId : slides[0].id;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: typeof value.id === "string" && value.id ? value.id : uid(),
    title: String(value.title ?? "政経ニュースコーナー"),
    airDate: String(value.airDate ?? today()),
    currentSlideId,
    voicevox: {
      baseUrl: String(value.voicevox?.baseUrl ?? "http://127.0.0.1:50021").replace(/\/$/, ""),
      speaker: Number.isInteger(Number(value.voicevox?.speaker)) ? Number(value.voicevox.speaker) : 3,
      speedScale: Number.isFinite(Number(value.voicevox?.speedScale)) ? Math.min(2, Math.max(.5, Number(value.voicevox.speedScale))) : 1,
    },
    slides,
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createDefaultRundown();
  try { return normalizeRundown(JSON.parse(raw)); }
  catch (error) {
    console.warn("保存済みランダウンを読み込めませんでした", error);
    return createDefaultRundown();
  }
}

let state = loadState();
let saveTimer = null;
let audio = null;
let audioUrl = null;
let playingCueId = null;

function currentIndex() {
  const index = state.slides.findIndex((slide) => slide.id === state.currentSlideId);
  return index >= 0 ? index : 0;
}

function currentSlide() {
  return state.slides[currentIndex()];
}

function scheduleSave() {
  $("save-status").textContent = "編集中";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("save-status").textContent = "保存済み";
  }, 180);
}

function setText(id, value, fallback = "") {
  $(id).textContent = value || fallback;
}

function renderSlideList() {
  const list = $("slide-list");
  list.replaceChildren();
  state.slides.forEach((slide, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.slideId = slide.id;
    button.setAttribute("aria-current", String(slide.id === state.currentSlideId));

    const number = document.createElement("span");
    number.className = "slide-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("span");
    title.className = "slide-title";
    title.textContent = slide.title || "無題";
    const section = document.createElement("span");
    section.className = "slide-section";
    section.textContent = slide.section || "未分類";

    button.append(number, title, section);
    button.addEventListener("click", () => selectSlide(slide.id));
    item.append(button);
    list.append(item);
  });

  const index = currentIndex();
  $("btn-move-up").disabled = index <= 0;
  $("btn-move-down").disabled = index >= state.slides.length - 1;
  $("btn-delete-slide").disabled = state.slides.length <= 1;
}

function renderPreview() {
  const slide = currentSlide();
  const index = currentIndex();
  setText("position-label", `${index + 1} / ${state.slides.length}`);
  setText("preview-section", slide.section, "未分類");
  setText("preview-index", String(index + 1).padStart(2, "0"));
  setText("preview-kicker", slide.kicker);
  setText("preview-title", slide.title, "無題");
  setText("preview-subtitle", slide.subtitle);
  setText("preview-notes", slide.notes, "—");

  const bullets = $("preview-bullets");
  bullets.replaceChildren();
  slide.bullets.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    bullets.append(li);
  });
  bullets.hidden = slide.bullets.length === 0;

  $("preview-sources").textContent = slide.sources.join("  /  ");
  $("preview-sources").hidden = slide.sources.length === 0;

  $("btn-prev").disabled = index <= 0;
  $("btn-next").disabled = index >= state.slides.length - 1;
}

function renderEditorFields() {
  const slide = currentSlide();
  $("program-title").value = state.title;
  $("program-date").value = state.airDate;
  $("voicevox-url").value = state.voicevox.baseUrl;
  $("voicevox-speaker").value = String(state.voicevox.speaker);
  $("voicevox-speed").value = String(state.voicevox.speedScale);
  $("field-section").value = slide.section;
  $("field-kicker").value = slide.kicker;
  $("field-title").value = slide.title;
  $("field-subtitle").value = slide.subtitle;
  $("field-bullets").value = slide.bullets.join("\n");
  $("field-sources").value = slide.sources.join("\n");
  $("field-notes").value = slide.notes;
  renderCueList();
}

function renderCueList() {
  const container = $("cue-list");
  container.replaceChildren();
  const slide = currentSlide();
  if (slide.cues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cue-empty";
    empty.textContent = "発話項目はありません";
    container.append(empty);
    return;
  }

  slide.cues.forEach((cue, index) => {
    const card = document.createElement("article");
    card.className = `cue-card${playingCueId === cue.id ? " playing" : ""}`;

    const meta = document.createElement("div");
    meta.className = "cue-meta";
    const labelField = document.createElement("label");
    labelField.textContent = "ラベル";
    const labelInput = document.createElement("input");
    labelInput.value = cue.label;
    labelInput.addEventListener("input", () => {
      cue.label = labelInput.value;
      scheduleSave();
    });
    labelField.append(labelInput);

    const speakerField = document.createElement("label");
    speakerField.textContent = "話者メモ";
    const speakerInput = document.createElement("input");
    speakerInput.value = cue.speakerLabel;
    speakerInput.addEventListener("input", () => {
      cue.speakerLabel = speakerInput.value;
      scheduleSave();
    });
    speakerField.append(speakerInput);
    meta.append(labelField, speakerField);

    const textField = document.createElement("label");
    textField.textContent = "読み上げ本文";
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.value = cue.text;
    textarea.addEventListener("input", () => {
      cue.text = textarea.value;
      scheduleSave();
    });
    textField.append(textarea);

    const actions = document.createElement("div");
    actions.className = "cue-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = playingCueId === cue.id ? "再生中" : "VOICEVOX再生";
    play.disabled = !cue.text.trim() || playingCueId === cue.id;
    play.addEventListener("click", () => void playCue(cue));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "削除";
    remove.addEventListener("click", () => {
      slide.cues.splice(index, 1);
      scheduleSave();
      renderCueList();
    });
    actions.append(play, remove);

    card.append(meta, textField, actions);
    container.append(card);
  });
}

function selectSlide(id) {
  if (!state.slides.some((slide) => slide.id === id)) return;
  stopAudio();
  state.currentSlideId = id;
  scheduleSave();
  renderSlideList();
  renderPreview();
  renderEditorFields();
}

function moveSelection(delta) {
  const next = currentIndex() + delta;
  if (next < 0 || next >= state.slides.length) return;
  selectSlide(state.slides[next].id);
}

function addSlide() {
  const index = currentIndex();
  const slide = createSlide();
  state.slides.splice(index + 1, 0, slide);
  state.currentSlideId = slide.id;
  scheduleSave();
  renderAll();
}

function deleteSlide() {
  if (state.slides.length <= 1) return;
  const index = currentIndex();
  state.slides.splice(index, 1);
  state.currentSlideId = state.slides[Math.min(index, state.slides.length - 1)].id;
  stopAudio();
  scheduleSave();
  renderAll();
}

function moveSlide(delta) {
  const index = currentIndex();
  const target = index + delta;
  if (target < 0 || target >= state.slides.length) return;
  const [slide] = state.slides.splice(index, 1);
  state.slides.splice(target, 0, slide);
  scheduleSave();
  renderSlideList();
  renderPreview();
}

function exportJson() {
  const blob = new Blob([`${JSON.stringify(state, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `politics-rundown-${state.airDate || today()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importJson(file) {
  const text = await file.text();
  const imported = normalizeRundown(JSON.parse(text));
  stopAudio();
  state = imported;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  $("save-status").textContent = "読込済み";
  renderAll();
}

function stopAudio() {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audio = null;
  audioUrl = null;
  playingCueId = null;
  renderCueList();
  $("voice-status").textContent = "停止";
}

async function voicevoxRequest(path, options = {}) {
  const baseUrl = state.voicevox.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`VOICEVOX HTTP ${response.status}`);
  return response;
}

async function checkVoicevox() {
  $("voice-status").textContent = "確認中…";
  try {
    const response = await voicevoxRequest("/version");
    const version = await response.text();
    $("voice-status").textContent = `接続OK ${version.replaceAll('"', "")}`;
  } catch (error) {
    $("voice-status").textContent = `接続失敗: ${error.message}`;
  }
}

async function playCue(cue) {
  stopAudio();
  playingCueId = cue.id;
  renderCueList();
  $("voice-status").textContent = "音声生成中…";
  try {
    const params = new URLSearchParams({ text: cue.text, speaker: String(state.voicevox.speaker) });
    const queryResponse = await voicevoxRequest(`/audio_query?${params}`, { method: "POST" });
    const query = await queryResponse.json();
    query.speedScale = state.voicevox.speedScale;
    const synthResponse = await voicevoxRequest(`/synthesis?speaker=${encodeURIComponent(state.voicevox.speaker)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    const blob = await synthResponse.blob();
    audioUrl = URL.createObjectURL(blob);
    audio = new Audio(audioUrl);
    audio.addEventListener("ended", () => stopAudio(), { once: true });
    audio.addEventListener("error", () => {
      playingCueId = null;
      renderCueList();
      $("voice-status").textContent = "音声の再生に失敗しました";
    }, { once: true });
    $("voice-status").textContent = `${cue.label || "発話"}を再生中`;
    await audio.play();
  } catch (error) {
    playingCueId = null;
    renderCueList();
    $("voice-status").textContent = `再生失敗: ${error.message}`;
  }
}

function bindTextField(id, property, { lines = false, program = false } = {}) {
  $(id).addEventListener("input", (event) => {
    const value = lines
      ? event.target.value.split("\n").map((entry) => entry.trim()).filter(Boolean)
      : event.target.value;
    if (program) state[property] = value;
    else currentSlide()[property] = value;
    scheduleSave();
    renderPreview();
    if (property === "title" || property === "section") renderSlideList();
  });
}

function bindEvents() {
  bindTextField("program-title", "title", { program: true });
  $("program-date").addEventListener("input", (event) => {
    state.airDate = event.target.value;
    scheduleSave();
  });
  bindTextField("field-section", "section");
  bindTextField("field-kicker", "kicker");
  bindTextField("field-title", "title");
  bindTextField("field-subtitle", "subtitle");
  bindTextField("field-bullets", "bullets", { lines: true });
  bindTextField("field-sources", "sources", { lines: true });
  bindTextField("field-notes", "notes");

  $("voicevox-url").addEventListener("change", (event) => {
    state.voicevox.baseUrl = event.target.value.trim().replace(/\/$/, "");
    scheduleSave();
  });
  $("voicevox-speaker").addEventListener("change", (event) => {
    state.voicevox.speaker = Math.max(0, Number.parseInt(event.target.value, 10) || 0);
    event.target.value = String(state.voicevox.speaker);
    scheduleSave();
  });
  $("voicevox-speed").addEventListener("change", (event) => {
    state.voicevox.speedScale = Math.min(2, Math.max(.5, Number(event.target.value) || 1));
    event.target.value = String(state.voicevox.speedScale);
    scheduleSave();
  });

  $("btn-add-slide").addEventListener("click", addSlide);
  $("btn-delete-slide").addEventListener("click", deleteSlide);
  $("btn-move-up").addEventListener("click", () => moveSlide(-1));
  $("btn-move-down").addEventListener("click", () => moveSlide(1));
  $("btn-prev").addEventListener("click", () => moveSelection(-1));
  $("btn-next").addEventListener("click", () => moveSelection(1));
  $("btn-add-cue").addEventListener("click", () => {
    currentSlide().cues.push(createCue());
    scheduleSave();
    renderCueList();
  });
  $("btn-voice-check").addEventListener("click", () => void checkVoicevox());
  $("btn-voice-stop").addEventListener("click", stopAudio);
  $("btn-export").addEventListener("click", exportJson);
  $("btn-import").addEventListener("click", () => $("file-import").click());
  $("file-import").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try { await importJson(file); }
    catch (error) { window.alert(`JSONを読み込めませんでした: ${error.message}`); }
    event.target.value = "";
  });
  $("btn-reset").addEventListener("click", () => {
    if (!window.confirm("現在の番組データを消して、初期サンプルへ戻しますか？")) return;
    stopAudio();
    state = createDefaultRundown();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("save-status").textContent = "初期化済み";
    renderAll();
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "ArrowLeft") moveSelection(-1);
    if (event.key === "ArrowRight") moveSelection(1);
  });
  window.addEventListener("beforeunload", () => {
    if (audio) audio.pause();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });
}

function renderAll() {
  renderSlideList();
  renderPreview();
  renderEditorFields();
}

bindEvents();
renderAll();
$("save-status").textContent = localStorage.getItem(STORAGE_KEY) ? "保存済み" : "初期サンプル";
