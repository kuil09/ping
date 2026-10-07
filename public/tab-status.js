export const TAB_UI_VERSION = "tab-countdown-v1";
const ATTENTION_MS = 12000;
const PHASE_MS = 1500;
const alertIcon = (inverse) => {
  const bg = inverse ? "#f4f1ea" : "#141414";
  const fg = inverse ? "#141414" : "#f4f1ea";
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><circle cx="32" cy="32" r="23" fill="none" stroke="${fg}" stroke-width="3"/><path d="M32 15v22" stroke="${fg}" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="47" r="4" fill="${fg}"/></svg>`);
};
export const ALERT_ICONS = [alertIcon(false), alertIcon(true)];

/** Absolute deadlines, never a decrementing counter: delayed callbacks cannot accumulate drift. */
export function countdown(until, now) {
  const seconds = Number.isFinite(until) && Number.isFinite(now)
    ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Pure presentation state, independently testable without a DOM or a browser clock. */
export class TabStatus {
  constructor() { this.reset(); }
  reset() {
    this.unread = false;
    this.attentionAt = 0;
    this.seen = new Set();
  }
  notice(signal, selfId, focused, now) {
    if (!signal?.eventId || this.seen.has(signal.eventId)) return;
    this.seen.add(signal.eventId);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
    if (signal.clientId === selfId || focused || signal.pingUntil <= now) return;
    this.unread = true;
    this.attentionAt = now;
  }
  view(ping, now, total, active, focused, reducedMotion = false) {
    const live = Boolean(ping && ping.pingUntil > now);
    if (focused || !live) this.unread = false;
    const time = live ? countdown(ping.pingUntil, now) : null;
    const age = Math.max(0, now - this.attentionAt);
    const pulsing = live && this.unread && !reducedMotion && age < ATTENTION_MS;
    const phase = pulsing ? Math.floor(age / PHASE_MS) % 2 : 0;
    // Keep the countdown first so it remains visible in narrow/truncated tabs.
    const label = this.unread ? (phase ? "새 핑" : "PING!") : "ping";
    return {
      title: live ? `${time} · ${label} · ${active}/${total}명` : `ping · ${total}명`,
      icon: this.unread ? ALERT_ICONS[phase] : live ? "/icon-active.svg" : "/icon.svg",
      unread: this.unread,
      pulsing,
      countdown: time,
    };
  }
}
