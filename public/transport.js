export const PROTOCOL = "ping-ws-v1";
export function credential() {
  let key;
  try { key = localStorage.getItem("ping:v2:credential"); } catch { /* page-local fallback */ }
  if (!/^[a-f0-9]{64}$/.test(key || "")) key = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem("ping:v2:credential", key); } catch { /* storage is optional */ }
  return key;
}
/** All live actions share one authenticated WebSocket. No HTTP presence or state polling. */
export class ChannelConnection {
  constructor(roomId, callbacks) {
    this.roomId = roomId; this.callbacks = callbacks; this.key = credential(); this.socket = null;
    this.pending = new Map(); this.ready = false; this.stopped = true; this.attempt = 0; this.connecting = false;
    this.retry = null; this.heartbeat = null; this.handshake = null; this.lastMessage = 0;
  }
  start() { this.stopped = false; clearTimeout(this.retry); void this.connect(); }
  async connect() {
    if (this.stopped || this.connecting || this.socket || navigator.onLine === false) return;
    this.connecting = true;
    try {
      const response = await fetch("/api/config", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("configuration_unavailable");
      const config = await response.json();
      if (config.protocol !== PROTOCOL) throw new Error("reload_required");
      if (this.stopped) return;
      this.callbacks.config?.(config);
      const url = new URL(`/api/rooms/${this.roomId}/ws`, location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      this.socket = ws; this.lastMessage = Date.now();
      this.handshake = setTimeout(() => ws.close(4000, "handshake_timeout"), 10000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, credential: this.key, visible: document.visibilityState !== "hidden" }));
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastMessage > 45000) { ws.close(4000, "heartbeat_timeout"); return; }
          if (ws.readyState === WebSocket.OPEN) ws.send("~ping");
        }, 15000);
      };
      ws.onmessage = event => {
        if (this.socket !== ws) return;
        this.lastMessage = Date.now();
        if (event.data === "~pong") return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "welcome") {
            clearTimeout(this.handshake); this.ready = true; this.attempt = 0;
            this.callbacks.welcome?.(message.clientId, message.state);
          } else if (message.type === "state") this.callbacks.state?.(message.state);
          else if (message.type === "ack" || message.type === "error") {
            const pending = this.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(message.id);
              if (message.type === "ack") pending.resolve({ ...message.state, signal: message.signal });
              else pending.reject(new Error(message.error));
            } else if (message.type === "error") this.callbacks.error?.(new Error(message.error));
          }
        } catch (error) { this.callbacks.error?.(error); }
      };
      ws.onerror = () => { /* onclose owns cleanup/backoff; never start a parallel polling loop. */ };
      ws.onclose = event => {
        if (this.socket !== ws) return;
        this.socket = null; this.ready = false;
        clearInterval(this.heartbeat); clearTimeout(this.handshake);
        this.rejectPending(); this.callbacks.disconnected?.();
        if (event.code === 4006) { this.stopped = true; this.callbacks.error?.(new Error("reload_required")); return; }
        this.reconnect();
      };
    } catch (error) {
      if (error.message === "reload_required") this.stopped = true;
      this.callbacks.error?.(error); this.reconnect();
    }
    finally { this.connecting = false; }
  }
  reconnect() {
    clearTimeout(this.retry);
    if (this.stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.retry = setTimeout(() => void this.connect(), delay + Math.random() * 300);
  }
  command(type, payload = {}, id = crypto.randomUUID()) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not_connected"));
    if (this.pending.has(id)) return Promise.reject(new Error("request_pending"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("request_timeout")); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ ...payload, type, id })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  visibility() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "visibility", visible: document.visibilityState !== "hidden" }));
  }
  rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("not_connected")); }
    this.pending.clear();
  }
  stop() {
    this.stopped = true; this.ready = false;
    clearTimeout(this.retry); clearTimeout(this.handshake); clearInterval(this.heartbeat);
    this.rejectPending(); const ws = this.socket; this.socket = null;
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close(1000, "page_stopped");
    this.callbacks.disconnected?.();
  }
}
