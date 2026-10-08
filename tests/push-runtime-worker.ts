// Bundled only by the isolated runtime test, never the production entry point.
import { sendPush, validSubscription, type PushEnv, type Subscription } from "../src/push.ts";
export { PingRoom } from "../src/room.ts";
export default {
  async fetch(_request: Request, env: PushEnv & { TEST_SUB: Subscription }) {
    let capture: unknown;
    const status = await sendPush(env, env.TEST_SUB, { type: "signal", roomId: "runtime-test" }, async (input, init) => {
      capture = { endpoint: String(input), headers: Object.fromEntries(new Headers(init?.headers)),
        body: Array.from(new Uint8Array(init?.body as Uint8Array)), redirect: init?.redirect };
      return new Response(null, { status: 201 });
    });
    return Response.json({ status, capture, valid: validSubscription(env.TEST_SUB),
      invalid: validSubscription({ ...env.TEST_SUB, endpoint: "https://localhost/private" }) });
  },
};
