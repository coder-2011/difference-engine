import "server-only";
import Pusher from "pusher";

type RealtimeConfiguration = { appId: string; cluster: string; key: string; secret: string };

/** Reads the server-only Pusher configuration without exposing its secret to the browser. */
export function realtimeConfiguration(): RealtimeConfiguration | undefined {
  const { PUSHER_APP_ID: appId, PUSHER_CLUSTER: cluster, PUSHER_KEY: key, PUSHER_SECRET: secret } = process.env;
  return appId && cluster && key && secret ? { appId, cluster, key, secret } : undefined;
}

/** Creates a short-lived client for publishing or authorizing one private channel. */
export function realtimeClient(configuration: RealtimeConfiguration): Pusher {
  return new Pusher({ ...configuration, timeout: 5_000, useTLS: true });
}
