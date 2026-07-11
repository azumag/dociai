type GlobalShortcutLike = {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
};

export type ShortcutRegistration = { triggerId: string; accelerator: string; registered: boolean; reason?: "occupied" | "invalid" | "registration_failed" };
export type ShortcutStatus = { entries: ShortcutRegistration[]; updatedAt: number };

const MODIFIERS = new Map([
  ["alt", "Alt"], ["option", "Alt"], ["ctrl", "Control"], ["control", "Control"],
  ["shift", "Shift"], ["meta", "CommandOrControl"], ["cmd", "CommandOrControl"], ["command", "CommandOrControl"],
]);
const NAMED_KEYS = new Map([["space", "Space"], ["tab", "Tab"], ["enter", "Enter"], ["return", "Enter"], ["escape", "Esc"], ["esc", "Esc"], ["backspace", "Backspace"], ["delete", "Delete"], ["home", "Home"], ["end", "End"], ["pageup", "PageUp"], ["pagedown", "PageDown"], ["up", "Up"], ["down", "Down"], ["left", "Left"], ["right", "Right"]]);

function normalizeKey(value: string): string {
  const raw = value.trim().toLowerCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(raw)) return raw.toUpperCase();
  if (/^[a-z]$/.test(raw) || /^\d$/.test(raw)) return raw.toUpperCase();
  if (NAMED_KEYS.has(raw)) return NAMED_KEYS.get(raw)!;
  throw new TypeError("unsupported shortcut key");
}

export function normalizeShortcut(spec: unknown): string {
  if (typeof spec !== "string" || spec.trim().length === 0 || spec.length > 128) throw new TypeError("shortcut must be a non-empty string");
  const parts = spec.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const modifiers: string[] = [];
  let key: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIERS.get(part);
    if (modifier) {
      if (modifiers.includes(modifier)) throw new TypeError("duplicate shortcut modifier");
      modifiers.push(modifier);
    } else {
      if (key !== null) throw new TypeError("shortcut must contain one key");
      key = normalizeKey(part);
    }
  }
  if (!key) throw new TypeError("shortcut key is required");
  return [...["CommandOrControl", "Control", "Alt", "Shift"].filter((modifier) => modifiers.includes(modifier)), key].join("+");
}

export class ShortcutService {
  #registered = new Map<string, string>();
  #status: ShortcutStatus = { entries: [], updatedAt: Date.now() };
  #disposed = false;

  constructor(private readonly globalShortcut: GlobalShortcutLike, private readonly emitStatus: (status: ShortcutStatus) => void = () => {}, private readonly emitTrigger: (event: { triggerId: string }) => void = () => {}) {}

  sync(triggers: Record<string, unknown> = {}): ShortcutStatus {
    if (this.#disposed) return this.#status;
    this.#unregisterTracked();
    const entries: ShortcutRegistration[] = [];
    for (const [triggerId, raw] of Object.entries(triggers)) {
      const trigger = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      if (trigger.type !== "hotkey" || trigger.global !== true) continue;
      let accelerator: string;
      try { accelerator = normalizeShortcut(trigger.keys); }
      catch { entries.push({ triggerId, accelerator: typeof trigger.keys === "string" ? trigger.keys.slice(0, 128) : "", registered: false, reason: "invalid" }); continue; }
      let registered = false;
      try {
        registered = this.globalShortcut.register(accelerator, () => this.emitTrigger({ triggerId }));
      } catch { entries.push({ triggerId, accelerator, registered: false, reason: "registration_failed" }); continue; }
      if (registered) this.#registered.set(triggerId, accelerator);
      entries.push({ triggerId, accelerator, registered, ...(registered ? {} : { reason: "occupied" as const }) });
    }
    this.#status = { entries, updatedAt: Date.now() };
    this.emitStatus(this.status());
    return this.status();
  }

  status(): ShortcutStatus { return { updatedAt: this.#status.updatedAt, entries: this.#status.entries.map((entry) => ({ ...entry })) }; }

  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.#unregisterTracked(); this.#status = { entries: [], updatedAt: Date.now() }; }

  #unregisterTracked(): void {
    for (const accelerator of this.#registered.values()) { try { this.globalShortcut.unregister(accelerator); } catch {} }
    this.#registered.clear();
  }
}
