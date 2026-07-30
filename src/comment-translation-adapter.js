// CommentSpeechPipeline (src/comment-speech-pipeline.js) が要求する
// `{ translate({text, sourceLanguage, targetLanguage, signal}) => Promise<{text}> }` という
// 「投げるかresolveするか」の形と、Electron IPCの `Result<T>` 形を橋渡しするアダプタ
// (issue #257 Phase 2, #261)。src/platform/electron-services.jsは他の全サービスと同じく
// Result<T>をunwrapしない流儀を保っているため、unwrap自体はここで行う。
//
// requestIdはこちら側で先に発番する: cancel()はrequestId指定で呼ぶ必要があるため、
// translate()の応答を待ってからでは間に合わない (signalがabortした時点でまだ応答が
// 返っていない可能性がある)。
import { translateThroughElectron, cancelElectronTranslationRequest } from "./platform/electron-services.js";

let sequence = 0;
function generateRequestId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  sequence += 1;
  return `translation-${Date.now()}-${sequence}`;
}

export function createElectronTranslationAdapter() {
  return {
    async translate({ text, sourceLanguage, targetLanguage, signal }) {
      const requestId = generateRequestId();
      const onAbort = () => { void cancelElectronTranslationRequest(requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await translateThroughElectron({ text, sourceLanguage, targetLanguage, requestId });
        if (!result.ok) {
          const error = new Error(result.error.message);
          error.code = result.error.code;
          error.retryable = result.error.retryable;
          throw error;
        }
        return { text: result.value.text };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
