// 翻訳engineをworker_threadで動かすworkerエントリ。
// 背景: onnxruntime-nodeのInferenceSession生成・run()は同期ネイティブ呼び出しであり
// (node_modules/onnxruntime-node/lib/backend.tsの`setImmediate` + 同期native call)、約22秒の
// モデルロードや翻訳1件(~960ms)をElectron Main processのメインスレッドで実行すると、その間
// アプリ全体 (ウィンドウ描画・IPC応答・メニュー) が固まる。これをworker_threadへ移すことで
// メインスレッドをブロックしないようにする (translation-runtime.tsのコメントに「将来Main
// processの応答性が問題になった場合はworker_thread化を検討する」と明記されていた経緯)。
//
// ここは純粋なメッセージループであり、モデルの遅延import・ロード共有・timeout・retryの
// 実体はTranslationRuntime (translation-runtime.ts) にそのまま任せる。要求はFIFOで直列化する:
// onnxruntimeのsessionに対してrun()を並行実行せず (renderer側のCommentSpeechPipelineがtranslate
// を1件ずつ順番に呼ぶ設計と一致させる)、応答順を保証してMain側の状態反映を単調にする。
import { parentPort, workerData } from "node:worker_threads";
import { TranslationRuntime } from "./translation-runtime";

type WorkerData = {
  cacheDir: string;
  modelId?: string;
  loadTimeoutMs?: number;
  // テスト専用のseam: 実モデルロードを避けたい場合に差し替え先moduleの絶対pathまたは
  // file:// URLを渡す。productionでは未指定のまま、TranslationRuntimeの既定 (実
  // @huggingface/transformersの動的import) を使う。
  importModulePath?: string;
};

type WorkerRequest = {
  type: "warmup" | "translate" | "ping";
  requestId: string;
  text?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
};

const data = workerData as WorkerData;

// 動的importのspecifierはstringとして扱う (TSがouter変数をnarrowしないため、引数経由で
// 確実にstringへ絞り込む)。
const makeImportModule = (modulePath: string) => () => import(modulePath);

const runtime = new TranslationRuntime({
  cacheDir: data.cacheDir,
  ...(typeof data.modelId === "string" ? { modelId: data.modelId } : {}),
  ...(typeof data.loadTimeoutMs === "number" ? { loadTimeoutMs: data.loadTimeoutMs } : {}),
  ...(typeof data.importModulePath === "string" ? { importModule: makeImportModule(data.importModulePath) } : {}),
});

// Main側へ返す状態のスナップショット。Errorはstructured-cloneできないためlastErrorは
// {message}へ変換して送る (Main側でnew Error()に復元する)。
function snapshot() {
  return {
    state: runtime.state,
    modelId: runtime.modelId,
    lastError: runtime.lastError ? { message: runtime.lastError.message } : undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handle(message: WorkerRequest): Promise<void> {
  if (message.type === "ping") {
    parentPort?.postMessage({ type: "pong", requestId: message.requestId, ...snapshot() });
    return Promise.resolve();
  }
  if (message.type === "warmup") {
    return runtime.warmUp().then(
      () => parentPort?.postMessage({ type: "warmup:ok", requestId: message.requestId, ...snapshot() }),
      (error) => parentPort?.postMessage({ type: "warmup:error", requestId: message.requestId, message: messageOf(error), ...snapshot() }),
    );
  }
  if (message.type === "translate") {
    return runtime.translate(message.text ?? "", message.sourceLanguage ?? "", message.targetLanguage ?? "").then(
      (text) => parentPort?.postMessage({ type: "translate:ok", requestId: message.requestId, text, ...snapshot() }),
      (error) => parentPort?.postMessage({ type: "translate:error", requestId: message.requestId, message: messageOf(error), ...snapshot() }),
    );
  }
  return Promise.resolve();
}

let chain: Promise<void> = Promise.resolve();
parentPort?.on("message", (raw: unknown) => {
  const message = raw as WorkerRequest;
  chain = chain
    .then(() => handle(message))
    // handle()は自身でエラーを捕捉して応答をpostするため、ここへ落ちるのは想定外の失敗のみ。
    // postMessage失敗 (portが閉じた等) でもchainをrejectで止めず、次のメッセージ処理へ続ける。
    .catch((error) => {
      try {
        parentPort?.postMessage({ type: "unknown-error", requestId: message?.requestId, message: messageOf(error) });
      } catch {
        /* parentPort closed — nothing more we can report */
      }
    });
});
