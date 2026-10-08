import webpush from "web-push";
import { Buffer } from "node:buffer";
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };
export function vapid(env: PushEnv) {
  const publicKey = (env.VAPID_PUBLIC_KEY || "").trim(), privateKey = (env.VAPID_PRIVATE_KEY || "").trim();
  let subject = (env.VAPID_SUBJECT || "").trim();
  if (/^[^\s:@]+@[^\s@]+$/.test(subject)) subject = `mailto:${subject}`;
  try { if (publicKey && privateKey && /^(mailto:|https:\/\/)/.test(subject)) {
    if (Buffer.from(publicKey, "base64url").length === 65 && Buffer.from(privateKey, "base64url").length === 32) return { publicKey, privateKey, subject };
  } } catch { /* optional invalid configuration */ }
  return null;
}
export function validSubscription(value: unknown): value is Subscription {
  if (!value || typeof value !== "object") return false;
  const s = value as Subscription;
  try {
    const u = new URL(s.endpoint), h = u.hostname;
    const trusted = h === "fcm.googleapis.com" || h === "web.push.apple.com" || h === "updates.push.services.mozilla.com" ||
      h.endsWith(".push.services.mozilla.com") || h.endsWith(".notify.windows.com");
    return trusted && u.protocol === "https:" && (!u.port || u.port === "443") && !u.username && !u.password && s.endpoint.length < 2048 &&
      typeof s.keys?.p256dh === "string" && /^[A-Za-z0-9_-]{87}=?$/.test(s.keys.p256dh) &&
      typeof s.keys?.auth === "string" && /^[A-Za-z0-9_-]{22}={0,2}$/.test(s.keys.auth);
  } catch { return false; }
}
/** Build encrypted Web Push using the established library, then use Workers fetch, not node:https. */
export async function sendPush(env: PushEnv, subscription: Subscription, payload: unknown): Promise<number> {
  const details = vapid(env);
  if (!details) return 0;
  try {
    const request = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
      TTL: 300, urgency: "high", vapidDetails: details,
    });
    const response = await fetch(request.endpoint, { method: "POST", headers: request.headers as HeadersInit,
      body: new Uint8Array(request.body as Buffer), redirect: "error", signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.status;
  } catch { return 0; }
}
