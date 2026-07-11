import { assertObsTransport } from "../obs-transport.js";

export class BroadcastChannelTransport {
  constructor({ name = "dociai-obs", Channel = BroadcastChannel } = {}) { this.name = name; this.Channel = Channel; this.channel = null; this.listener = null; }
  start(listener) {
    if (this.channel) return false;
    this.listener = listener;
    this.channel = new this.Channel(this.name);
    this.channel.onmessage = ({ data }) => this.listener?.(data);
    return true;
  }
  send(message) { if (!this.channel) return false; this.channel.postMessage(message); return true; }
  stop() { if (!this.channel) return false; this.channel.close(); this.channel = null; this.listener = null; return true; }
  status() { return { connected: Boolean(this.channel), kind: "broadcast-channel" }; }
}
assertObsTransport(BroadcastChannelTransport.prototype);
