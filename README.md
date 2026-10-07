# ping

One shared link, a ping button, and an explicit availability switch. No account, name, chat, or location.

## Deploy

Attach a managed Deno KV database to the app; keep `main.ts` as the entrypoint. `Deno.openKv()` uses the database attached to the active timeline. Do not configure a per-instance local SQLite database in production.

Use the same production URL and `/r/<channel-id>` on all devices. Production, branch and build-preview timelines have separate databases. Optional `PUBLIC_ORIGIN` makes the share button use a chosen production HTTPS origin.

## State lifecycle

Each **new deployment/configuration** starts with empty channel state. Keys are scoped by the platform's `DENO_DEPLOYMENT_ID` (falling back to `DENO_DEPLOY_BUILD_ID`) and timeline. Sibling instances share the same namespace; scaling up or restarting a process must not clear another instance's data.

This is a logical reset, not a global database flush. Previous namespaces are not read or migrated by the new deployment, and their records retain their 24-hour expiry. No process runs `delete everything` during startup or warm-up. VAPID secrets are environment configuration, not KV data, and are not reset.

Channel membership, availability, latest ping, replay log, and server-side push subscriptions all start empty in the new namespace. Open clients rejoin and re-register existing push subscriptions automatically. **Closed clients cannot re-register until they reopen the app; after a deployment they do not receive new pushes until then.** User notification permission and the stable VAPID key need not be recreated.

References:
- https://docs.deno.com/deploy/reference/env_vars_and_contexts/
- https://docs.deno.com/deploy/reference/deno_kv/
- https://docs.deno.com/deploy/reference/runtime/

## Three separate states

- **Presence:** each page session renews a 45-second lease every 15 seconds while visible. At least one live session means one browser participant in the channel. At the lease deadline the participant disappears from the current user list and count, even if no leave beacon arrived. Server-side outgoing SSE bytes do not renew presence. Hiding a page pauses heartbeats; pagehide may send a best-effort leave beacon. A remaining live tab keeps the participant present.
- **Availability:** the user explicitly chooses `가능` or `불가능`. This is an absolute boolean stored per channel/browser, synchronized to other devices and same-browser tabs. Pings, heartbeat, and signal expiry never flip it. Failed writes leave the last confirmed selection unchanged. New participants default to available. An expired presence is not the same as an explicit unavailable selection. Inactive membership records can preserve availability for a return within 24 hours, but are excluded from the live list and counts and may be evicted to admit new users.
- **Ping:** every new button press, by any participant, creates a new event and refreshes the shared channel clock and five-minute expiry. This works while a prior ping is already active. The sender also has an individual five-minute ring. A departing sender is removed from membership, but the channel ping continues until its own expiry. Availability changes do not create a ping, ring an alert, or move the clock.

The central button shows the shared ping fading for five minutes. Above it, the latest server-confirmed time, elapsed time and remaining lifetime are displayed. Reload and reconnect recover the same timestamp, not the page-open time. Only the most recent timestamp is shown, not a history. An expired timestamp remains marked ended until replaced or reset by a new deployment.

Small participant rings show availability with a filled core or a slash plus a text label. `나` identifies the current browser. The outer ping rings remain independent of availability. Availability does not mute notifications or prevent pressing the ping button.

## Transport

```
Browser A -> POST -> any instance -> deployment-scoped shared Deno KV
Browser B <- SSE + replay <- another instance <- KV watch
Background subscriber <- Web Push <- shared subscriptions in this deployment
```

A KV watch can coalesce changes. A bounded sequence log reconstructs individual events with `Last-Event-ID`; it is not inferred from the number of watch notifications. Duplicate POST retries reuse the same request ID and do not refresh the timer again. New presses use new IDs. The replay log retains up to 128 unexpired events, not unlimited history. Each participant can send one new ping per second. Up to 64 participant records and eight concurrent tabs per browser are supported.

Core networking works without notification, service-worker, storage or audio APIs. Audio requires a user gesture and is optional. A five-second state poll backs up SSE. Lease deadlines are applied on reads and in the UI, without waiting for physical KV key deletion. An SSE snapshot refresh runs every five seconds, and stream rotation enables regular reconnects. Clients discard retired deployment generations and reconnect rather than merging old and new state.

## Web Push

Set stable `VAPID_PUBLIC_KEY`, secret `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:address@example.com` or HTTPS contact URL). A bare email subject is normalized. Invalid VAPID configuration disables only Web Push, not signaling. Existing subscriptions with a different application-server key require the notification button to be used again.

OS notification sound and delivery timing remain browser/OS controlled. Browser automation verifies foreground signaling, not real-device background OS delivery.

## Run and test

```
deno task dev
deno task check
deno task test
```

Local development uses `./ping-local.sqlite3`. For multiple local processes use a remote KV service with `PING_KV_URL` and `DENO_KV_ACCESS_TOKEN`. `PING_STATE_GENERATION` can simulate separate deployments locally; deployed apps use the platform identity instead.

CI runs unit tests and two separate Deno processes sharing a temporary KV service. Mobile Chromium/WebKit tests cover independent availability, remote/repeated clock refresh, malformed values, failed saves, missing optional APIs, multiple tabs, channel isolation, live 45-second silent-disconnect expiry, and SSE replay. Screenshots and logs are artifacts. Production smoke runs these foreground checks against a fresh, unshared production channel, never against an existing user's room.

`/api/health` reports non-secret version, instance and generation identifiers and verifies KV connectivity. A passing CI run is separate from a passing production smoke run.
