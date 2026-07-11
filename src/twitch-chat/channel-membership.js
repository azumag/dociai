export class ChannelMembership {
  #channels = new Map();
  constructor(channels = []) { for (const channel of channels) this.#channels.set(channel, { channel, status: "pending", lastMessageAt: null, error: null }); }
  joined(channel) { this.#set(channel, { status: "joined", error: null }); }
  parted(channel) { this.#set(channel, { status: "left" }); }
  failed(channel, error) { this.#set(channel, { status: "failed", error: String(error ?? "unknown error") }); }
  message(channel) { this.#set(channel, { lastMessageAt: Date.now() }); }
  snapshot() { return [...this.#channels.values()].map((entry) => ({ ...entry })); }
  allJoined() { const values = [...this.#channels.values()]; return values.length > 0 && values.every((entry) => entry.status === "joined" || entry.status === "failed"); }
  #set(channel, patch) { const current = this.#channels.get(channel) ?? { channel, status: "pending", lastMessageAt: null, error: null }; this.#channels.set(channel, { ...current, ...patch }); }
}
