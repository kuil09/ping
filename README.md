# ping

A tiny ephemeral signal PWA.

- No account
- No chat
- One shared room per URL
- One-tap signal
- SSE while open
- Web Push when configured
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

Optional Web Push environment variables:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (for example `mailto:you@example.com`)

Without VAPID variables, the app still works through SSE while the page is open.

## Product model

The URL is the room. A signal lives for 5 minutes and then disappears. There are no accounts, names, messages, history, or persistent storage.
