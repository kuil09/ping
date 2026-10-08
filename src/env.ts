import type { PingRoom } from "./room.ts";
import type { PushEnv } from "./push.ts";
export interface Env extends PushEnv {
  ROOMS: DurableObjectNamespace<PingRoom>;
  ASSETS: Fetcher;
  CF_VERSION_METADATA: { id: string; tag?: string; timestamp?: string };
}
export const generation = (env: Env) => env.CF_VERSION_METADATA?.id || "local";
