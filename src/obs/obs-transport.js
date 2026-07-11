export function assertObsTransport(transport) {
  if (!transport || typeof transport.start !== "function" || typeof transport.send !== "function" || typeof transport.stop !== "function") throw new TypeError("ObsTransport requires start/send/stop");
  return transport;
}
