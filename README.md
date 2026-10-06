# ping

A tiny ephemeral signal PWA.

- No account
- No chat
- One shared room per URL
- One-tap signal
- SSE while open
- Web Push while closed/backgrounded
- All runtime state is in memory and may disappear on restart

## Run

```bash
deno task dev
```

Open:

```
http://localhost:8000/r/demo
```

## Deno Deploy

Entrypoint: `main.ts`

No database, Redis, or required environment variables.

At startup the server generates an ephemeral VAPID key pair for Web Push. On restart, room state, subscriptions, and the VAPID key all reset together.

Optional overrides:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

## Product model

The URL is the room. A signal lives for 5 minutes and then disappears. There are no accounts, names, messages, history, or persistent storage.
