const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");
const usersEl = document.querySelector("#users");
const statusEl = document.createElement("p");
statusEl.id = "status";
statusEl.setAttribute("role", "status");
statusEl.style.cssText = "position:fixed;bottom:36px;left:16px;right:16px;text-align:center;font-size:12px;opacity:.7";
document.querySelector("main").appendChild(statusEl);

function uid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function storedClientId() {
  let value;
  try { value = localStorage.getItem("ping:clientId"); } catch { /* private mode */ }
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) value = uid();
  try { localStorage.setItem("ping:clientId", value); } catch { /* page-local identity still works */ }
  return value;
}
const clientId = storedClientId();
const sessionId = uid();
const api = `/api/rooms/${encodeURIComponent(roomId)}`;
let users = [];
let epoch = null;
let revision = -1;
let sequence = 0;
let clockOffset = 0;
let source;
let streamAlive = false;
let lastStreamAt = 0;
let audioContext;
let pendingRequestId;
let presenceBusy = false;
let stateBusy = false;
let config = { pushEnabled: false, vapidPublicKey: null, signalTtlMs: 300000 };
let registrationPromise;
const seen = new Set();
const visible = () => document.visibilityState !== "hidden";
const now = () => Date.now() + clockOffset;
const cursor = () => epoch ? `${epoch}:${sequence}` : null;

function status(message = "") { statusEl.textContent = message; }
function transport(ready) {
  connection.classList.toggle("online", ready);
  signalButton.disabled = !ready;
  document.body.dataset.ready = String(ready);
}
function showError(error) {
  const code = error?.message;
  status(code === "shared_storage_unavailable" || code === "service_unavailable"
    ? "공유 저장소 연결 필요"
    : code === "too_fast" ? "잠시 후 다시 누르기" : "연결 실패 · 다시 시도 중");
}
async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, {
      cache: "no-store", signal: controller.signal,
      ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "request_failed");
    return value;
  } finally { clearTimeout(timer); }
}

// Optional sound must never prevent the POST or the event listener from running.
function unlockAudio() {
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    audioContext ??= new Audio();
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => {});
  } catch { /* autoplay, device or policy restriction */ }
}
function playPing() {
  try {
    if (!visible() || audioContext?.state !== "running") return;
    const start = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(920, start);
    oscillator.frequency.exponentialRampToValueAtTime(460, start + 0.48);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.62);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + 0.64);
  } catch { /* visual state is already applied */ }
}
function alertPing() {
  playPing();
  try { if (visible()) navigator.vibrate?.([25, 25, 45]); } catch { /* optional */ }
}

function drawUsers() {
  usersEl.replaceChildren();
  for (const user of users) {
    const item = document.createElement("div");
    item.className = "user";
    item.dataset.clientId = user.clientId;
    item.dataset.self = String(user.clientId === clientId);
    const dot = document.createElement("span");
    dot.className = "user-dot";
    const core = document.createElement("span");
    core.className = "user-core";
    dot.appendChild(core);
    item.appendChild(dot);
    usersEl.appendChild(item);
  }
  refreshDisplay();
}
function refreshDisplay() {
  const time = now();
  let active = 0;
  let maxLife = 0;
  const items = usersEl.querySelectorAll(".user");
  users.forEach((user, i) => {
    const life = Math.min(1, Math.max(0, user.pingUntil - time) / config.signalTtlMs);
    if (life > 0) active++;
    maxLife = Math.max(maxLife, life);
    const item = items[i];
    if (!item) return;
    item.dataset.active = String(life > 0);
    item.dataset.online = String(user.online);
    item.style.setProperty("--user-life", String(life));
    item.style.opacity = user.online || life > 0 ? "1" : ".3";
    item.setAttribute("aria-label", `${user.clientId === clientId ? "나" : "사용자"} · ${user.online ? "접속" : "미접속"} · 핑 ${life > 0 ? "ON" : "OFF"}`);
  });
  const title = active ? `ping · ${active}/${users.length}` : `ping · ${users.length}`;
  if (document.title !== title) document.title = title;
  const favicon = document.querySelector('link[rel="icon"]');
  const icon = active ? "/icon-active.svg" : "/icon.svg";
  if (favicon && favicon.getAttribute("href") !== icon) favicon.setAttribute("href", icon);
  usersEl.setAttribute("aria-label", `${users.length}명 · ${active}명 핑 ON`);
  const center = signalButton.querySelector("span");
  if (center) {
    center.style.opacity = String(0.16 + 0.84 * maxLife);
    center.style.width = `${46 + 18 * maxLife}%`;
  }
}
function acceptSignal(signal, audible = true) {
  if (!signal?.eventId || seen.has(signal.eventId)) return;
  seen.add(signal.eventId);
  if (seen.size > 256) seen.delete(seen.values().next().value);
  const signalEpoch = signal.eventId.slice(0, signal.eventId.lastIndexOf(":"));
  if (epoch && epoch !== signalEpoch) return;
  epoch = signalEpoch;
  sequence = Math.max(sequence, signal.sequence);
  let user = users.find((u) => u.clientId === signal.clientId);
  if (!user) {
    user = { clientId: signal.clientId, online: true, pingUntil: 0 };
    users.push(user);
  }
  user.pingUntil = Math.max(user.pingUntil, signal.pingUntil);
  drawUsers();
  if (audible && now() - signal.createdAt < 10000 && signal.pingUntil > now()) alertPing();
}
function applyState(state) {
  if (!Array.isArray(state.users) || !state.epoch) throw new Error("reload_required");
  if (epoch === state.epoch && (state.revision < revision || state.sequence < sequence)) return;
  const initial = epoch === null || epoch !== state.epoch;
  if (initial) { epoch = state.epoch; revision = -1; sequence = 0; seen.clear(); }
  clockOffset = state.serverTime - Date.now();
  if (!initial) {
    for (const signal of state.events || []) if (signal.sequence > sequence) acceptSignal(signal);
  }
  users = state.users;
  revision = state.revision;
  sequence = state.sequence;
  drawUsers();
  transport(true);
  status();
}

async function heartbeat() {
  if (presenceBusy || !visible()) return;
  presenceBusy = true;
  try { applyState(await request(`${api}/presence`, { clientId, sessionId, online: true })); }
  catch (error) { transport(false); showError(error); }
  finally { presenceBusy = false; }
}
async function poll() {
  if (stateBusy || !visible() || (streamAlive && Date.now() - lastStreamAt < 20000)) return;
  stateBusy = true;
  try { applyState(await request(`${api}/state`)); }
  catch (error) { transport(false); showError(error); }
  finally { stateBusy = false; }
}
function connectEvents() {
  source?.close();
  streamAlive = false;
  if (!visible() || !("EventSource" in globalThis)) return;
  const query = new URLSearchParams({ clientId, sessionId });
  if (cursor()) query.set("since", cursor());
  source = new EventSource(`${api}/events?${query}`);
  source.addEventListener("users", (event) => {
    try {
      applyState(JSON.parse(event.data));
      streamAlive = true;
      lastStreamAt = Date.now();
    } catch (error) { showError(error); }
  });
  source.addEventListener("signal", (event) => {
    try { acceptSignal(JSON.parse(event.data)); lastStreamAt = Date.now(); }
    catch (error) { showError(error); }
  });
  source.onerror = () => { streamAlive = false; void poll(); };
}

signalButton.addEventListener("click", async () => {
  if (document.body.classList.contains("sending")) return;
  unlockAudio();
  document.body.classList.add("sending");
  pendingRequestId ??= uid();
  try {
    const state = await request(`${api}/signal`, { clientId, sessionId, requestId: pendingRequestId });
    acceptSignal(state.signal);
    applyState(state);
    pendingRequestId = undefined;
  } catch (error) {
    showError(error);
    if (error.message === "too_fast") pendingRequestId = undefined;
  } finally { document.body.classList.remove("sending"); }
});

document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("keydown", unlockAudio);
shareButton.addEventListener("click", async () => {
  try {
    const url = new URL(location.pathname, config.publicOrigin || location.origin).href;
    if (navigator.share) await navigator.share({ url });
    else if (navigator.clipboard) { await navigator.clipboard.writeText(url); status("링크 복사됨"); }
  } catch { /* share canceled */ }
});

const supportsPush = () => "Notification" in globalThis && "PushManager" in globalThis && "serviceWorker" in navigator;
function decodeKey(value) {
  const raw = atob((value + "=".repeat((4 - value.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
async function registerPush(interactive = false) {
  if (!config.pushEnabled || !supportsPush() || !registrationPromise) return;
  if (Notification.permission !== "granted") {
    if (!interactive || await Notification.requestPermission() !== "granted") return;
  }
  const registration = await registrationPromise;
  if (!registration) return;
  let subscription = await registration.pushManager.getSubscription();
  const expected = decodeKey(config.vapidPublicKey);
  const previous = subscription?.options?.applicationServerKey;
  const mismatched = previous && (previous.byteLength !== expected.length || new Uint8Array(previous).some((b, i) => b !== expected[i]));
  if (mismatched) {
    notifyButton.classList.remove("active");
    if (!interactive) return;
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    if (!interactive) return;
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expected });
  }
  await request(`${api}/subscribe`, { clientId, sessionId, subscription: subscription.toJSON() });
  notifyButton.classList.add("active");
}
notifyButton.addEventListener("click", () => {
  void registerPush(true).catch(() => { notifyButton.classList.remove("active"); notifyButton.title = "알림 등록 실패 · 다시 시도"; });
});
async function optionalFeatures() {
  try {
    if ("serviceWorker" in navigator) {
      registrationPromise = navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => null);
    }
    config = { ...config, ...await request("/api/config") };
    notifyButton.hidden = !config.pushEnabled || !supportsPush();
    void registerPush().catch(() => {});
  } catch { notifyButton.hidden = true; }
}
function leave() {
  source?.close();
  streamAlive = false;
  try {
    navigator.sendBeacon?.(`${api}/presence`, new Blob([JSON.stringify({ clientId, sessionId, online: false })], { type: "application/json" }));
  } catch { /* the presence lease expires if the beacon cannot be sent */ }
}
function resume() {
  if (!visible()) return;
  connectEvents();
  void heartbeat();
  void registerPush().catch(() => {});
}
document.addEventListener("visibilitychange", () => visible() ? resume() : leave());
globalThis.addEventListener("pagehide", leave);
globalThis.addEventListener("pageshow", (event) => { if (event.persisted) resume(); });
globalThis.addEventListener("online", resume);
globalThis.addEventListener("offline", () => { streamAlive = false; transport(false); status("オフライン".replace("オフライン", "오프라인")); });

transport(false);
notifyButton.hidden = true;
// Network participation starts first. Push, service workers and audio are not prerequisites.
connectEvents();
void heartbeat();
void optionalFeatures();
setInterval(() => { if (visible()) refreshDisplay(); }, 250);
setInterval(() => void heartbeat(), 15000);
setInterval(() => void poll(), 5000);
