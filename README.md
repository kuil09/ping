# ping

One URL, one button, independent five-minute signals. No account, name, chat, location, or message history UI.

## Deployment prerequisite

**Attach a managed Deno KV database to this Deno Deploy app before deploying this branch.**

In the Deno Deploy dashboard, open the app's **Databases** tab, choose **Attach Database → Provision Database → Deno KV**, and wait for the assignment to be Connected. Keep `main.ts` as the entrypoint. `Deno.openKv()` then connects to the appropriate managed database automatically; no additional database credentials belong in this repository.

The previous process-local Map/BroadcastChannel implementation was not a valid multi-instance design for the new Deno Deploy runtime. Deploy Classic's cross-instance BroadcastChannel behavior must not be assumed on the new platform. Restart tolerance does not make isolated instances share their current state.

Reference: https://docs.deno.com/deploy/reference/runtime/
Reference: https://docs.deno.com/deploy/reference/deno_kv/
Reference: https://docs.deno.com/deploy/classic/api/runtime-broadcast-channel/

## Architecture

```
Browser A → HTTP POST → any Deno Deploy instance → shared Deno KV
Browser B ← SSE + replay ← another instance ← KV watch
Background browser ← Web Push ← shared subscription records
```

Channel membership, per-user ping expiry, and the bounded replay log are changed atomically in one channel record. A KV watch is a notification to read shared state, not an event log: it can coalesce updates, so SSE events are reconstructed from the retained sequence log. `Last-Event-ID` supports reconnecting to a different instance. Process memory holds connections only, never authoritative channel data.

Presence and signal state are separate:

- `online`: at least one page session refreshed its 45-second lease. Visible pages send a heartbeat every 15 seconds; page hide sends a best-effort leave beacon. Multiple tabs count as one browser participant.
- `pingUntil`: this participant's independent five-minute signal. Disconnecting does not erase the signal. Repeated pings generate new event IDs and refresh only the sender's expiry.
- Inactive participants remain visible, dimmed, for up to 24 hours after their last visit; a ping is visually ON only until its own expiry. This is anonymous browser membership, not verified human identity.

Rooms and subscriptions have a 24-hour expiry. Read-time deadlines are checked even before KV physically removes expired keys. The replay log retains at most 128 unexpired signals. A reconnect outside this retention window recovers the current snapshot, not an unlimited history. Channels are bounded to 64 browser participants and 8 simultaneous tabs per participant. Each participant can send at most one new ping per second. A retry using the same request ID is idempotent within the retained log.

## Browser behavior

SSE and presence start independently from service workers, notification permission, Web Push, and audio. Missing `Notification`, blocked storage, failed service-worker registration, or unavailable audio must not disable signaling. A 5-second state poll is a fallback when SSE is unavailable; mobile foreground restoration reconnects and refreshes state.

The UI shows each member's ping ON/OFF separately from online/offline presence. A ping's visual strength decreases using server timestamps; the browser tab shows active/total membership and changes its favicon only when activity changes. Optional sound requires a user gesture and is never a prerequisite for POST or SSE.

API responses are never cached by the service worker. Offline pages cannot send a ping and show a connection error rather than pretending delivery succeeded.

## Stable URLs

Use the app's **production domain** and the same `/r/<channel-id>` path on all devices. Do not mix immutable build-preview URLs, branch timelines, and production: Deno Deploy isolates databases by timeline, and origins also have separate browser storage and push subscriptions.

Optionally set `PUBLIC_ORIGIN` to the production HTTPS origin to make the share button use it. Confirm the production domain in the Deno dashboard rather than guessing a build-preview URL.

## Web Push

Configure a stable, generated key pair in Deploy environment variables:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY` (secret; never commit or log it)
- `VAPID_SUBJECT` (`mailto:address@example.com` or an HTTPS contact URL)

A bare email subject is normalized. Invalid configuration disables only Web Push, not the app. Existing subscriptions with a different application-server key require the notification button to be used again. OS notification sound and delivery timing remain browser/OS controlled; these are not guarantees of the in-page audio implementation.

## Run and test

```
deno task dev
deno task check
deno task test
```

Local development explicitly uses `./ping-local.sqlite3`. For multiple local processes, use a shared remote KV backend and set `PING_KV_URL` and `DENO_KV_ACCESS_TOKEN` for each process. Do not point distributed production instances at separate local SQLite files.

CI starts a temporary `denokv` backend and two independent Deno processes, then runs Chromium and WebKit with mobile viewports. Tests cover cross-instance bidirectional signals, channel isolation, duplicate tabs, missing optional browser APIs, independent online/active states, simultaneous writes, idempotent retries, five-minute expiry, and SSE replay after switching instances. The test KV token is temporary CI-only data, not a production credential. Screenshots and server logs are retained as CI artifacts.

`GET /api/health` verifies KV connectivity and exposes non-secret version/instance identifiers. A passing syntax check alone is not a successful deployment or an end-to-end delivery test. Real-device background Web Push must still be verified after deployment.
