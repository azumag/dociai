// 画面キャプチャ文脈 (issue #9)
// getDisplayMedia で画面/ウィンドウ/タブを共有し、任意タイミングでフレームを
// Visionモデルへ送って screenSummary を更新する。maxAgeSeconds を超えた説明は使わない。

import { RequestCancelledError } from "./runtime/request-registry.js";
import { DEFAULT_SCREEN_CAPTURE_INSTRUCTION } from "./config/config-defaults.js";

export class ScreenContext {
  constructor({ config, getConnector, log = () => {} }) {
    this.cfg = config.context?.screenCapture ?? {};
    this.getConnector = getConnector;
    this.log = log;
    this.stream = null;
    this.video = null;
    this.summary = null;
    this.capturedAt = 0;
    this.updating = false;
    this.listeners = new Set();
  }

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    // displaySurface はブラウザのgetDisplayMediaピッカーに渡すヒント (Electronは自前のsource選択
    // UIでピッカー自体をバイパスするため無視される)。対応ブラウザでは指定した種別 (window/monitor/
    // browser) のタブが既定選択された状態でピッカーが開く。
    const surface = this.cfg.displaySurface;
    const video = surface ? { displaySurface: surface } : true;
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
    this.video = document.createElement("video");
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();
    // ブラウザUIの「共有を停止」で終了した場合にも追従する
    this.stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());
    this.log("画面共有を開始しました");
    this.#notify();
  }

  stop() {
    if (!this.stream) return;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.log("画面共有を停止しました");
    this.#notify();
  }

  captureFrame() {
    if (!this.video) throw new Error("画面共有が開始されていません");
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) throw new Error("映像フレームがまだ取得できません");
    const scale = Math.min(1, 1280 / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  }

  // フレームを取り込み、Visionコネクタで説明文を生成して保持する
  async updateContext(context = {}) {
    if (this.updating) throw new Error("画面の読み取りが進行中です");
    const connectorId = this.cfg.connector;
    if (!connectorId) throw new Error("context.screenCapture.connector が設定されていません");
    const connector = this.getConnector(connectorId);
    if (!connector) throw new Error(`コネクタ "${connectorId}" が見つかりません`);

    this.updating = true;
    this.#notify();
    try {
      const dataUrl = this.captureFrame();
      const messages = [
        { role: "system", content: "あなたはライブ配信画面の状況を実況スタッフに伝えるアシスタントです。" },
        {
          role: "user",
          content: [
            { type: "text", text: this.cfg.instruction || DEFAULT_SCREEN_CAPTURE_INSTRUCTION },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ];
      const { text } = await connector.chat(messages, { maxTokens: this.cfg.maxTokens ?? 768, signal: context.signal, requestId: context.requestId, generation: context.generation });
      if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) throw new RequestCancelledError("画面の読み取りは設定変更で停止しました", "stale-generation");
      this.summary = text;
      this.capturedAt = Date.now();
      this.log(`画面文脈を更新: ${text}`);
      return text;
    } finally {
      const stale = context.isCurrent && !context.isCurrent();
      if (!stale) {
        this.updating = false;
        this.#notify();
      }
    }
  }

  // 新鮮な画面説明だけを返す。maxAgeSeconds を超えていれば null。
  getFresh(maxAgeSeconds = this.cfg.maxAgeSeconds ?? 120) {
    if (!this.summary) return null;
    const ageSeconds = Math.round((Date.now() - this.capturedAt) / 1000);
    if (ageSeconds > maxAgeSeconds) return null;
    return { summary: this.summary, ageSeconds };
  }

  status() {
    const ageSeconds = this.summary ? Math.round((Date.now() - this.capturedAt) / 1000) : null;
    return {
      active: this.active,
      updating: this.updating,
      summary: this.summary,
      ageSeconds,
      stale: ageSeconds != null && ageSeconds > (this.cfg.maxAgeSeconds ?? 120),
    };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #notify() {
    for (const fn of this.listeners) fn(this);
  }
}
