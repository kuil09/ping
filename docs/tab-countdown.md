# Tab countdown and attention

The tab title starts with the shared channel ping's remaining time: `04:59 · ping · 1/3명` (one active sender among three currently connected participants). A new ping from anyone replaces the channel deadline, so all connected tabs return to approximately `05:00`. Duplicate network retries are not new pings. The title returns to `ping · 3명` when the deadline expires.

For an unseen peer ping, the title alternates `PING!` / `새 핑` and a high-contrast exclamation favicon alternates its foreground/background every 1.5 seconds for at most 12 seconds. Thereafter `PING!` and the alert icon remain steady until the tab is both visible and focused, or the ping expires. Focusing acknowledges attention only: it does not cancel the timer, send a ping, or change availability. Self pings and previously acknowledged event IDs do not demand attention. `prefers-reduced-motion: reduce` disables alternation but preserves the countdown and steady alert marker.

The lightweight title timer runs independently from the visible-page renderer. It recalculates from the absolute server-confirmed deadline rather than decrementing a local counter. Changes are written to document.title and the favicon only when needed. No window.focus, popups, permission requests, wake locks, silent audio, or timer-throttling bypasses are used.

## Connection lifecycle

This supersedes the earlier visibility-only network pause. Merely switching tabs no longer closes SSE or stops client heartbeats/fallback synchronization. An executable background page remains a connected participant. Actual pagehide/close/freeze stops networking. A suspended/disconnected page that cannot renew its session is still removed by the existing 45-second lease. A browser timer or network pause can therefore cause temporary presence expiry; returning resumes and synchronizes without cumulative countdown drift.

## Limits

Browsers may throttle or freeze background JavaScript; exact once-per-second updates and attention animation cannot be guaranteed while frozen or discarded. The next callback/focus/resume computes the correct remaining time immediately. Closed pages cannot update a tab; existing opt-in Web Push remains the separate notification path. Mobile browsers may hide the tab strip entirely. OS taskbar flashing or forcibly foregrounding the browser is not implemented.

Primary references:
- https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- https://developer.mozilla.org/en-US/docs/Web/API/Document/title

## Verification

Unit tests cover formatting boundaries, focus/expiry, duplicate events, peer renewal, reduced motion, delayed callbacks and deployment reset. Chromium and WebKit tests emulate visibility/focus lifecycle signals (headless tab switching is not reliable) while retaining real HTTP, native EventSource, real shared KV and real timers. They assert received events, changing document.title, favicon phases, renewal while hidden, focus acknowledgement and unchanged availability. These are application lifecycle tests, not a claim to emulate OS process suspension or prove native browser chrome rendering on every device. The existing 45-second silent-disconnect and mobile regression tests remain.

Production smoke waits for the exact SHA-256 hashes of the committed app.js, tab-status.js and sw.js before running browser tests on fresh unshared channels. The backend schema and VAPID settings are unchanged; the existing deployment-generation reset still applies.
