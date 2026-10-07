const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");
const usersEl = document.querySelector("#users");
const statusEl = document.querySelector("#status");
const availabilityButton = document.querySelector("#availability");
const availabilityState = document.querySelector("#availability-state");
const pingTime = document.querySelector("#ping-time");
const pingAge = document.querySelector("#ping-age");
const clockEl = document.querySelector("#ping-clock");
const memberCount = document.querySelector("#member-count");
const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function uid() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function storedClientId() {
  let value;
  try { value = localStorage.getItem("ping:clientId"); } catch { /* private mode */ }
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) value = uid();
  try { localStorage.setItem("ping:clientId", value); } catch { /* page-local identity */ }
  return value;
}
const clientId = storedClientId();
const sessionId = uid();
const api = `/api/rooms/${encodeURIComponent(roomId)}`;
let users = [];
let channelPing = null;
let generation = null;
let epoch = null;
let revision = -1;
let sequence = 0;
let clockOffset = 0;
let source;
let streamAlive = false;
let lastStreamAt = 0;
let ready = false;
let audioContext;
let pendingRequestId;
let availabilityBusy = false;
let presenceBusy = false;
let stateBusy = false;
let renderedIds = "";
let config = { pushEnabled: false, vapidPublicKey: null, signalTtlMs: 300000 };
let registrationPromise;
const retiredGenerations = new Set();
const seen = new Set();
const visible = () => document.visibilityState !== "hidden";
const now = () => Date.now() + clockOffset;
const cursor = () => epoch ? `${epoch}:${sequence}` : null;
const presentUsers = () => users.filter((user) => user.online && (user.onlineUntil ?? Infinity) > now());
function status(message = "") { statusEl.textContent = message; }
function transport(value) {
  ready = value;
  connection.classList.toggle("online", value);
  signalButton.disabled = !value;
  document.body.dataset.ready = String(value);
  refreshAvailability();
}
function adoptGeneration(next) {
  if (!next || next === generation) return true;
  if (retiredGenerations.has(next)) return false;
  const previous = generation;
  if (previous) retiredGenerations.add(previous);
  generation = next;
  epoch = null;
  revision = -1;
  sequence = 0;
  channelPing = null;
  users = [];
  seen.clear();
  pendingRequestId = undefined;
  if (previous) {
    source?.close();
    streamAlive = false;
    queueMicrotask(() => { connectEvents(); void registerPush().catch(() => {}); });
  }
  return true;
}
function showError(error) {
  const code = error?.message;
  if (code === "deployment_changed") {
    adoptGeneration(error.generation);
    transport(false);
    drawUsers();
    status("새 배포에 다시 연결 중");
    return;
  }
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
      ...(body ? { method: "POST", headers: { "content-type": "application/json", ...(generation ? { "x-ping-generation": generation } : {}) }, body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || "request_failed");
      error.generation = value.generation;
      throw error;
    }
    return value;
  } finally { clearTimeout(timer); }
}
function unlockAudio() {
  try {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    audioContext ??= new Audio();
    if (audioContext.state === "suspended") void audioContext.resume().catch(() => {});
  } catch { /* optional feature */ }
}
function alertPing() {
  try {
    if (!visible()) return;
    navigator.vibrate?.([25, 25, 45]);
  } catch { /* optional */ }
  try {
    if (!visible() || audioContext?.state !== "running") return;
    const start = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(920, start);
    oscillator.frequency.exponentialRampToValueAtTime(460, start + .48);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(.14, start + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, start + .62);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start);
    oscillator.stop(start + .64);
  } catch { /* sound never blocks state or transport */ }
}
function animatePing() {
  try {
    if (!visible() || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    signalButton.querySelector("span").animate([{ transform: "scale(.92)" }, { transform: "scale(1.07)" }, { transform: "scale(1)" }], { duration: 650, easing: "ease-out" });
  } catch { /* animation is optional */ }
}
function refreshAvailability() {
  const me = users.find((user) => user.clientId === clientId);
  availabilityButton.disabled = !ready || availabilityBusy || !me;
  availabilityButton.setAttribute("aria-busy", String(availabilityBusy));
  availabilityButton.setAttribute("aria-checked", String(me?.available !== false));
  availabilityState.textContent = me ? (me.available !== false ? "가능" : "불가능") : "연결 중";
}
function drawUsers() {
  const current = presentUsers();
  renderedIds = current.map((user) => user.clientId).join(",");
  usersEl.replaceChildren();
  for (const user of current) {
    const item = document.createElement("div");
    item.className = "user";
    item.setAttribute("role", "listitem");
    item.dataset.clientId = user.clientId;
    item.dataset.self = String(user.clientId === clientId);
    const dot = document.createElement("span");
    dot.className = "user-dot";
    const core = document.createElement("span");
    core.className = "user-core";
    const label = document.createElement("span");
    label.className = "user-label";
    dot.appendChild(core);
    item.append(dot, label);
    usersEl.appendChild(item);
  }
  refreshDisplay();
}
function refreshDisplay() {
  const time = now();
  const current = presentUsers();
  if (renderedIds !== current.map((user) => user.clientId).join(",")) { drawUsers(); return; }
  let active = 0;
  const items = usersEl.querySelectorAll(".user");
  current.forEach((user, i) => {
    const life = Math.min(1, Math.max(0, user.pingUntil - time) / config.signalTtlMs);
    if (life > 0) active++;
    const item = items[i];
    const available = user.available !== false;
    item.dataset.active = String(life > 0);
    item.dataset.online = "true";
    item.dataset.available = String(available);
    item.style.setProperty("--user-life", String(life));
    item.querySelector(".user-label").textContent = `${user.clientId === clientId ? "나 · " : ""}${available ? "가능" : "불가능"}`;
    item.setAttribute("aria-label", `${user.clientId === clientId ? "나" : "사용자"} · ${available ? "가능" : "불가능"} · 핑 ${life > 0 ? "ON" : "OFF"}`);
  });
  const remaining = channelPing ? Math.max(0, channelPing.pingUntil - time) : 0;
  const life = Math.min(1, remaining / config.signalTtlMs);
  document.documentElement.style.setProperty("--life", String(life));
  clockEl.dataset.active = String(remaining > 0);
  clockEl.dataset.eventId = channelPing?.eventId || "";
  if (channelPing) {
    pingTime.dateTime = new Date(channelPing.createdAt).toISOString();
    pingTime.dataset.createdAt = String(channelPing.createdAt);
    pingTime.textContent = timeFormat.format(channelPing.createdAt);
    const seconds = Math.max(0, Math.floor((time - channelPing.createdAt) / 1000));
    const elapsed = seconds < 2 ? "방금" : seconds < 60 ? `${seconds}초 전` : `${Math.floor(seconds / 60)}분 전`;
    const left = Math.ceil(remaining / 1000);
    pingAge.textContent = remaining > 0 ? `${elapsed} · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 남음` : `${elapsed} · 종료`;
  } else {
    pingTime.removeAttribute("datetime");
    pingTime.removeAttribute("data-created-at");
    pingTime.textContent = "--:--:--";
    pingAge.textContent = "아직 없음";
  }
  const title = remaining > 0 ? `ping · ${active}/${current.length}` : `ping · ${current.length}`;
  if (document.title !== title) document.title = title;
  const favicon = document.querySelector('link[rel="icon"]');
  const icon = remaining > 0 ? "/icon-active.svg" : "/icon.svg";
  if (favicon && favicon.getAttribute("href") !== icon) favicon.setAttribute("href", icon);
  const availableCount = current.filter((user) => user.available !== false).length;
  memberCount.textContent = `${current.length}명 · ${availableCount}명 가능`;
  usersEl.setAttribute("aria-label", `${current.length}명 · ${availableCount}명 가능 · ${active}명 핑 ON`);
  refreshAvailability();
}
function acceptSignal(signal, audible = true) {
  if (!signal?.eventId || seen.has(signal.eventId)) return;
  if (signal.generation && generation && signal.generation !== generation) return;
  const signalEpoch = signal.eventId.slice(0, signal.eventId.lastIndexOf(":"));
  if (epoch && epoch !== signalEpoch) return;
  seen.add(signal.eventId);
  if (seen.size > 256) seen.delete(seen.values().next().value);
  epoch = signalEpoch;
  sequence = Math.max(sequence, signal.sequence);
  if (!channelPing || signal.sequence > channelPing.sequence) channelPing = signal;
  const user = users.find((u) => u.clientId === signal.clientId);
  if (user) { user.pingUntil = Math.max(user.pingUntil, signal.pingUntil); user.pingAt = signal.createdAt; }
  // A ping never changes anyone's manually selected availability.
  drawUsers();
  if (audible && now() - signal.createdAt < 10000 && signal.pingUntil > now()) { alertPing(); animatePing(); }
}
function applyState(state, fromStream = false) {
  if (!Array.isArray(state.users) || !state.epoch) throw new Error("reload_required");
  if (fromStream && generation && state.generation !== generation) return false;
  if (!adoptGeneration(state.generation)) return false;
  if (epoch === state.epoch && (state.revision < revision || state.sequence < sequence)) return false;
  const initial = epoch === null || epoch !== state.epoch;
  if (initial) { epoch = state.epoch; revision = -1; sequence = 0; channelPing = null; seen.clear(); }
  clockOffset = state.serverTime - Date.now();
  if (!initial) for (const signal of state.events || []) if (signal.sequence > sequence) acceptSignal(signal);
  users = state.users;
  channelPing = state.channelPing || null;
  revision = state.revision;
  sequence = state.sequence;
  drawUsers();
  transport(true);
  status();
  return true;
}
async function heartbeat() {
  if (presenceBusy || !visible()) return;
  presenceBusy = true;
  try { applyState(await request(`${api}/presence`, { clientId, sessionId, online: true })); }
  catch (error) { transport(false); showError(error); }
  finally { presenceBusy = false; }
}
async function poll() {
  if (stateBusy || !visible() || (streamAlive && Date.now() - lastStreamAt < 15000)) return;
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
  const current = new EventSource(`${api}/events?${query}`);
  source = current;
  current.addEventListener("users", (event) => {
    if (source !== current) return;
    try {
      if (applyState(JSON.parse(event.data), true)) { streamAlive = true; lastStreamAt = Date.now(); }
    } catch (error) { showError(error); }
  });
  current.addEventListener("signal", (event) => {
    if (source !== current) return;
    try { acceptSignal(JSON.parse(event.data)); lastStreamAt = Date.now(); }
    catch (error) { showError(error); }
  });
  current.onerror = () => { if (source === current) { streamAlive = false; void poll(); } };
}
signalButton.addEventListener("click", async () => {
  if (!ready || document.body.classList.contains("sending")) return;
  unlockAudio();
  document.body.classList.add("sending");
  pendingRequestId ??= uid();
  try {
    const state = await request(`${api}/signal`, { clientId, sessionId, requestId: pendingRequestId });
    if (applyState(state)) acceptSignal(state.signal);
    pendingRequestId = undefined;
  } catch (error) { showError(error); if (error.message === "too_fast") pendingRequestId = undefined; }
  finally { document.body.classList.remove("sending"); }
});
availabilityButton.addEventListener("click", async () => {
  const me = users.find((user) => user.clientId === clientId);
  if (!ready || !me || availabilityBusy) return;
  availabilityBusy = true;
  refreshAvailability();
  try {
    const state = await request(`${api}/availability`, { clientId, sessionId, available: me.available === false });
    applyState(state);
  } catch (error) { showError(error); }
  finally { availabilityBusy = false; refreshAvailability(); }
});
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("keydown", unlockAudio);
shareButton.addEventListener("click", async () => {
  try {
    const url = new URL(location.pathname, config.publicOrigin || location.origin).href;
    if (navigator.share) await navigator.share({ url });
    else if (navigator.clipboard) { await navigator.clipboard.writeText(url); status("링크 복사됨"); }
  } catch { /* canceled */ }
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
    await subscription.unsubscribe(); subscription = null;
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
    if ("serviceWorker" in navigator) registrationPromise = navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => null);
    config = { ...config, ...await request("/api/config") };
    notifyButton.hidden = !config.pushEnabled || !supportsPush();
    void registerPush().catch(() => {});
  } catch { notifyButton.hidden = true; }
}
function pause() { source?.close(); streamAlive = false; }
function leave() {
  pause();
  try {
    navigator.sendBeacon?.(`${api}/presence`, new Blob([JSON.stringify({ clientId, sessionId, online: false })], { type: "application/json" }));
  } catch { /* no beacon needed: lease expiry removes this session */ }
}
function resume() {
  if (!visible()) return;
  connectEvents(); void heartbeat(); void registerPush().catch(() => {});
}
// Hidden is not an explicit leave. If suspended, the 45-second lease expires naturally.
document.addEventListener("visibilitychange", () => visible() ? resume() : pause());
globalThis.addEventListener("pagehide", leave);
globalThis.addEventListener("pageshow", (event) => { if (event.persisted) resume(); });
globalThis.addEventListener("online", resume);
globalThis.addEventListener("offline", () => { pause(); transport(false); status("오프라인"); });
transport(false);
notifyButton.hidden = true;
connectEvents();
void heartbeat();
void optionalFeatures();
setInterval(() => { if (visible()) refreshDisplay(); }, 250);
setInterval(() => void heartbeat(), 15000);
setInterval(() => void poll(), 5000);
