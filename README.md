# ping

A shared link, one ping button, explicit availability, and an optional nickname. No account, chat, or location.

## Interaction

New participants start **불가능 (unavailable)**, including before JavaScript initializes. Only the user's availability switch can choose **가능**. Nickname edits, incoming/outgoing pings, heartbeats and countdown expiry never change that choice. Reloads and sibling tabs retain a confirmed choice within the same channel/deployment. A new deployment starts unavailable again.

The inline nickname editor accepts up to 20 Unicode code points, normalizes Korean to NFC, trims repeated whitespace, and supports changing/clearing a name. Blank means **익명**. Nicknames are channel-scoped display labels, not authentication or unique identities. Equal names do not merge participants. All labels use textContent/bdi, never user-supplied HTML. A failed save keeps the draft and the last confirmed peer state. No login or blocking onboarding screen is introduced.

Each new ping refreshes the shared five-minute timer and its server-confirmed timestamp. The sender has a separate fading ring. Tab countdown and bounded unread attention remain active in executable background tabs; see [tab behavior](docs/tab-countdown.md). Availability does not mute notifications or prevent a ping.

## Local history

A quiet, initially collapsed **이력** control below the participants opens a date-grouped timeline. It includes confirmed ping timestamps, observed availability/nickname changes, and observed connection arrivals/departures. Filter by all activity or pings, load more records, or erase this channel's local history with inline confirmation.

History lives only in this browser's **localStorage**, separated by channel: `ping:history:v1:<channel>:`. It is not posted to the server, shared with other participants, or synchronized across devices. There is no new server history table or history API. Live KV contains only current state/change timestamps and the existing bounded five-minute ping replay log.

- Retain the latest **300 entries / 30 days per channel**. One key per event prevents different tabs from overwriting distinct writes. Storage events refresh sibling tabs.
- Stable server event IDs and per-profile change revisions deduplicate SSE, POST responses, snapshots and replay. A ping keeps the sender's nickname at send time, even after a later rename.
- The initial participant snapshot is a baseline, not invented arrival or profile-change history. Retained confirmed pings may be recovered from the existing short replay log. Intermediate profile changes that were never observed, activity while closed, and an unlimited past cannot be reconstructed. Connection departures are labeled by confirmation time, not a claimed exact physical exit time.
- Erasing history leaves live channel state, identity, other channels and other applications untouched. A local watermark suppresses erased old pings when the server replays them.
- Storage denial, corruption or quota exhaustion falls back to the current page's memory with a visible notice; it never blocks signaling or the availability switch. Clearing browser site data also removes the history.
- A new server deployment resets KV state but **does not erase local history**. Names/availability are not silently uploaded from old local history to repopulate a fresh deployment.

## Deploy and lifecycle

Attach managed Deno KV to the app and use `main.ts`. Do not use separate local SQLite databases for distributed production instances. Use the same production origin and `/r/<channel>` on all devices; build-preview/branch timelines have isolated data. `PUBLIC_ORIGIN` optionally fixes the share origin.

Runtime KV keys are scoped by `DENO_DEPLOYMENT_ID` (fallback `DENO_DEPLOY_BUILD_ID`) and timeline. Sibling instances share state. A new deployment/configuration starts an empty namespace; previous keys retain their 24-hour TTL. No instance runs a global database flush. The reset includes server push subscriptions: an open/reopened app re-registers; a closed app cannot receive fresh pushes after a deployment until reopened. VAPID environment secrets and browser permission remain.

Each executable page renews its 45-second presence lease every 15 seconds, including background tabs. Freeze/close/disconnect stops renewal. Users disappear from the current list/count when all their leases expire, even without a leave beacon. A live sibling tab keeps the participant present. Outgoing SSE bytes do not renew a lease. The latest channel ping survives its sender's departure until its own deadline.

Transport is POST → shared atomic Deno KV → KV watch → SSE. A bounded sequence log, not the number of watch callbacks, supplies ping replay. Retry IDs are idempotent. The existing limits are 64 participants, eight tabs per browser, one new ping per second per participant, and 128 retained unexpired ping events. Optional notification, service-worker, sound and storage APIs are not prerequisites for the core transport.

## Web Push

Keep stable `VAPID_PUBLIC_KEY`, secret `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:address@example.com` or HTTPS contact URL). Invalid configuration disables only Push. Browser/OS delivery timing and notification sound are not guaranteed by in-page tests. Real-device background Push remains a separate verification step.

## Development and verification

```
deno task dev
deno task check
deno task test
```

Local development uses `./ping-local.sqlite3`. Multiple local processes need a shared `PING_KV_URL` and temporary `DENO_KV_ACCESS_TOKEN`. `PING_STATE_GENERATION` simulates deployments locally.

CI retains the state/tab tests and adds nickname/history tests. Two independent app processes sharing temporary KV run Chromium/WebKit regression tests, including real silent-disconnect timeout, native SSE/replay, hidden-lifecycle countdown, nicknames, failed saves, quota denial, persistence, clear/replay behavior and screenshots. Production smoke verifies exact committed browser asset hashes first and uses only new unshared channels. CI success, deployment success and production smoke are separate gates.

References:
- https://docs.deno.com/deploy/reference/deno_kv/
- https://docs.deno.com/deploy/reference/env_vars_and_contexts/
- https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
- https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event
