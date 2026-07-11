import { downloadDiagnosticExport, serializeDiagnosticExport } from "../../health/diagnostic-export.js";

export class DiagnosticExportDialog {
  constructor(dialog, { document = dialog?.ownerDocument ?? globalThis.document, onStatus = () => {} } = {}) {
    this.dialog = dialog; this.document = document; this.onStatus = onStatus; this.payload = null;
    if (!dialog || !document?.createElement) return;
    dialog.setAttribute("aria-labelledby", "diagnostic-export-title");
    const title = document.createElement("h2"); title.id = "diagnostic-export-title"; title.textContent = "診断エクスポート";
    this.preview = document.createElement("pre"); this.preview.className = "diagnostic-export-preview"; this.preview.setAttribute("aria-label", "診断エクスポート内容");
    const status = document.createElement("p"); status.className = "muted"; status.setAttribute("aria-live", "polite"); this.status = status;
    const close = document.createElement("button"); close.type = "button"; close.textContent = "閉じる"; close.addEventListener("click", () => this.close());
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "コピー"; copy.addEventListener("click", () => this.copy());
    const download = document.createElement("button"); download.type = "button"; download.textContent = "ダウンロード"; download.addEventListener("click", () => this.download());
    const actions = document.createElement("div"); actions.className = "btn-row"; actions.append(close, copy, download);
    dialog.replaceChildren(title, this.preview, status, actions);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
  }
  open(payload) {
    this.payload = payload; if (!this.preview) return;
    this.preview.textContent = serializeDiagnosticExport(payload); this.status.textContent = "トークン、ヘッダー、プロンプト、ユーザー本文、絶対パスは含めません";
    if (typeof this.dialog.showModal === "function") this.dialog.showModal(); else this.dialog.open = true;
  }
  close() { if (!this.dialog) return; if (this.dialog.open && typeof this.dialog.close === "function") this.dialog.close(); else this.dialog.open = false; }
  async copy() {
    if (!this.payload) return false;
    try {
      const writeText = this.document.defaultView?.navigator?.clipboard?.writeText;
      if (typeof writeText !== "function") throw new Error("clipboard unavailable");
      await writeText.call(this.document.defaultView.navigator.clipboard, serializeDiagnosticExport(this.payload));
      this.status.textContent = "コピーしました"; this.onStatus("copied"); return true;
    }
    catch { this.status.textContent = "コピーできませんでした。内容を選択してコピーしてください"; return false; }
  }
  download() { const ok = downloadDiagnosticExport(this.payload, { document: this.document }); this.status.textContent = ok ? "ダウンロードを開始しました" : "ダウンロードできませんでした"; return ok; }
}
