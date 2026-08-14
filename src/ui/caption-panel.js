// 操作卓の「英語CC」パネル (issue #282)。
//
// Main process の CaptionSession が算出した CaptionStatus をそのまま描画するだけで、
// このファイル自身は状態を持たない。OBSパスワード・session token・ワーカーURLはCaptionStatusに
// 含まれないので、Renderer側にそれらが現れる経路は存在しない。
//
// 「即時停止スイッチを常に操作可能にする」(issue #282) ため、停止ボタンだけはどの状態でも押せる。

const HEALTH_LABELS = Object.freeze({
  disabled: "停止中",
  chrome_not_found: "Chrome未検出",
  worker_disconnected: "Chrome未接続",
  microphone_permission_required: "マイク許可待ち",
  recognition_starting: "認識開始中",
  recognizing: "聞き取り中",
  recognition_stopped: "認識停止中",
  translator_downloading: "翻訳DL中",
  translator_ready: "翻訳準備完了",
  obs_disconnected: "OBS未接続",
  obs_not_streaming: "OBS未配信",
  mic_muted: "マイクミュート",
  sending: "送出中",
  error: "エラー",
});

// 破棄理由 (CaptionRejectReason) をテスト字幕の結果表示へ出すための文言。
const REJECT_LABELS = Object.freeze({
  disabled: "英語CCが停止しています",
  "not-final": "確定前の認識結果です",
  empty: "本文が空です",
  "too-long": "本文が長すぎます",
  "control-characters": "使用できない制御文字が含まれています",
  "source-language-leak": "日本語が残っているため破棄しました",
  duplicate: "直前と同じ字幕のため破棄しました",
  expired: "古い字幕のため破棄しました",
  "stale-generation": "停止前の字幕のため破棄しました",
  "queue-overflow": "送出待ちが上限に達しました",
  obs_disconnected: "OBSへ接続していません",
  obs_not_streaming: "OBSが配信中ではありません",
  mic_muted: "対象マイクがミュートされています",
  caption_unsupported: "接続中のOBSはSendStreamCaptionに対応していません",
  request_failed: "OBSへの送出に失敗しました",
  chrome_not_found: "Google Chromeが見つかりません",
  chrome_launch_failed: "Chromeを起動できませんでした",
  worker_host_failed: "字幕ワーカーを起動できませんでした",
  // 失敗ではなく「進行中の送出の後に送られる」状態。
  queued: "進行中の送出の後に送られます",
});

const describeReason = (reason) => REJECT_LABELS[reason] ?? String(reason ?? "");

export class CaptionPanel {
  // 直前のrenderがエラー表示だったかどうか。エラー解消時に消し忘れの旧文言を残さないために使う。
  #lastMessageWasError = false;

  // onStatus は「描画したstatus」を毎回呼び出し元へ渡す。subscribe側だけで拾うと、
  // 起動直後に一度だけpullするstatus (refresh) が連携ヘルスへ反映されず、最初の状態変化が
  // 起きるまでヘルス行が"unknown"のままになる。
  constructor(root, services, { log = () => {}, onStatus = () => {} } = {}) {
    this.root = root;
    this.services = services;
    this.log = log;
    this.onStatus = onStatus;
    this.status = null;
    this.elements = {
      health: root.querySelector("#caption-health"),
      states: root.querySelector("#caption-states"),
      recognized: root.querySelector("#caption-recognized"),
      caption: root.querySelector("#caption-caption"),
      message: root.querySelector("#caption-status"),
      open: root.querySelector("#btn-caption-open"),
      start: root.querySelector("#btn-caption-start"),
      stop: root.querySelector("#btn-caption-stop"),
      test: root.querySelector("#btn-caption-test"),
    };
  }

  connect() {
    this.root.hidden = false;
    this.elements.open.addEventListener("click", () => void this.#run(() => this.services.openWorker(), "Chromeを開きました"));
    this.elements.start.addEventListener("click", () => void this.#run(() => this.services.start(), "英語CCを開始しました"));
    this.elements.stop.addEventListener("click", () => void this.#run(() => this.services.stop(), "英語CCを停止しました"));
    this.elements.test.addEventListener("click", () => void this.#test());
    this.unsubscribe = this.services.subscribe((status) => this.render(status));
    void this.refresh();
    return () => this.unsubscribe?.();
  }

  async refresh() {
    const result = await this.services.status();
    if (result?.ok) this.render(result.value);
  }

  render(status) {
    if (!status) return;
    this.status = status;
    this.onStatus(status);
    this.elements.health.textContent = HEALTH_LABELS[status.health] ?? status.health;
    this.elements.health.dataset.health = status.health;
    const rows = [
      ["Chrome", status.worker.chromeFound ? (status.worker.connected ? "接続済み" : "未接続") : "未検出"],
      ["認識", status.worker.state === "recognizing" ? "聞き取り中" : status.worker.state === "microphone_permission_required" ? "許可待ち" : "停止"],
      ["翻訳", status.worker.state === "translator_ready" || status.worker.state === "recognizing" ? "利用可能" : status.worker.state === "translator_downloading" ? "ダウンロード中" : status.worker.state === "translator_unavailable" ? "利用不可" : "未確認"],
      ["OBS", status.obs.connected ? (status.obs.captionSupported ? "接続済み" : "CC非対応") : "未接続"],
      ["配信", status.obs.streaming ? "LIVE" : "OFFLINE"],
      ["マイク入力", status.obs.micMuted ? "MUTE" : "ON"],
      ["送出", `${status.counters.sent}件 / 破棄${status.counters.rejected}件`],
    ];
    this.elements.states.replaceChildren(...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }));
    this.elements.recognized.textContent = status.lastRecognized;
    this.elements.caption.textContent = status.lastCaption;
    this.elements.start.disabled = !status.enabled || status.running;
    this.elements.open.disabled = !status.enabled;
    this.elements.test.disabled = !status.running;
    if (status.lastError) this.#message(status.lastError.message, true);
    else if (!status.enabled) this.#message("設定で英語CCを有効にしてください");
    // エラーが解消したら、消し忘れの古いエラー文言を出したままにしない (aria-liveで読まれ続ける)。
    // ボタン操作の成功/送出結果メッセージ (this.#message() の他の呼び出し) は上書きしない —
    // ここで消すのは「直前のrenderがエラーだった」場合だけ。
    else if (this.#lastMessageWasError) this.#message("");
    this.#lastMessageWasError = Boolean(status.lastError);
  }

  async #run(action, successMessage) {
    const result = await action();
    if (!result?.ok) { this.#message(result?.error?.message ?? "操作に失敗しました", true); return; }
    // openChromeWorkerだけは ok:true でも opened:false (Chrome未検出等) がありうる。
    if (result.value?.opened === false) { this.#message(describeReason(result.value.reason), true); return; }
    if (result.value?.health !== undefined) this.render(result.value);
    this.#message(successMessage);
    this.log(successMessage);
    if (result.value?.health === undefined) void this.refresh();
  }

  async #test() {
    const result = await this.services.testCaption("dociai caption test.");
    if (!result?.ok) { this.#message(result?.error?.message ?? "テスト字幕に失敗しました", true); return; }
    if (result.value.sent) this.#message("テスト字幕を送出しました");
    else if (result.value.reason === "queued") this.#message(`テスト字幕を送出待ちに追加しました (${describeReason(result.value.reason)})`);
    else this.#message(`テスト字幕を送出できません: ${describeReason(result.value.reason)}`, true);
    void this.refresh();
  }

  #message(text, isError = false) {
    this.elements.message.textContent = text;
    this.elements.message.classList.toggle("error", isError);
  }
}
