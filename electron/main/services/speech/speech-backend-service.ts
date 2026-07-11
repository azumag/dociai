import { BouyomiService } from "./bouyomi-service";
import { VoiceVoxService } from "./voicevox-service";
export class SpeechBackendService {
  readonly voicevox: VoiceVoxService; readonly bouyomi: BouyomiService;
  constructor(fetchFn: typeof fetch = fetch) { this.voicevox = new VoiceVoxService(fetchFn); this.bouyomi = new BouyomiService(fetchFn); }
  cancel(requestId: string): boolean { return this.voicevox.cancel(requestId) || this.bouyomi.cancel(requestId); }
  dispose(): void { this.voicevox.dispose(); this.bouyomi.dispose(); }
}
