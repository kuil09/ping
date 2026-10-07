# Resource budget and rollout

## Applied server changes

- One KV watch per channel per app instance, not one per SSE subscriber. The KV room and bounded sequence log remain authoritative across independent instances.
- Replace each stream's five-second full KV refresh with one 60-second reconciliation per active channel. Unchanged revisions do not produce full snapshots.
- One small 25-second keepalive per active channel, without reading or writing KV. Cached lease/ping deadlines drive expiration updates; a server heartbeat never renews a client lease.
- Abort/cancel, stream rotation, lease expiry and slow-reader overflow detach subscribers. When the last subscriber disappears the channel's watch and all timers are canceled and removed. The per-stream queue is byte-bounded (64 KiB high-water mark, allowing one additional bounded frame).
- SSE rotation changes from three to ten minutes. Process eviction and network reconnect/replay remain supported.
- `/api/health` exposes only aggregate per-instance live counters. No room identifiers, profiles, VAPID keys or subscriptions are exposed. These are software counters, not Deno billing telemetry.

## Deployment/test cost

Full Chromium/WebKit regression and resource tests run against two local app processes and a local KV service in GitHub Actions. Automatic production verification is HTTP-only: at most six health checks and three static-asset reads, with no open channels, SSE or presence heartbeats. A full production suite requires explicit workflow_dispatch with full_browser=true. Superseded workflow runs are canceled. Batch source changes into one Git commit instead of triggering a deployment per file.

## Unchanged behavior and remaining constraints

The frontend is unchanged in this rollout: executable background tabs retain real-time connections and fifteen-second client heartbeats; availability, nickname onboarding, countdown, audio and local history are not altered. Same-browser multiple tabs still have independent network sessions; browser-side owner election is not included in this deployment. Presence remains a 45-second lease, independent of availability. KV reset on a new deployment still resets server push registrations; reopened clients re-register, while browser-local history remains.

These changes reduce duplicated watchers, reads, serializations and abandoned streams. They do not erase consumed quota and do not eliminate the memory-time floor of a live Deno instance. Keeping instant background signaling still keeps compute loaded. Do not claim a percentage reduction in Deno GiB-hours from the synthetic resource test. Existing organization verification, billing limits and preview-routing settings must be checked in the Deno console; this code does not change plans or authenticate an organization.

References: https://docs.deno.com/deploy/reference/runtime/ and https://deno.com/deploy/pricing
