export function twitchHealth(snapshot) {
  if (snapshot.offline) return { status: "offline", message: "ネットワーク接続を待っています" };
  if (snapshot.nextRetryAt) return { status: "retrying", message: "切断中のコメントは後から取得されません" };
  const channels = snapshot.channels ?? [];
  const joined = channels.filter((entry) => entry.status === "joined").length;
  const failed = channels.filter((entry) => entry.status === "failed").length;
  if (joined && failed) return { status: "degraded", message: `${joined} channel接続 / ${failed} channel失敗` };
  if (joined) return { status: "connected", message: `${joined} channel接続中` };
  if (channels.length && failed === channels.length) return { status: "unavailable", message: "全channelへの接続が拒否されました" };
  return { status: snapshot.state ?? "idle", message: "Twitch接続を準備しています" };
}
