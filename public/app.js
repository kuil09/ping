import { TAB_UI_VERSION, TabStatus } from "./tab-status.js";
import { normalizeNickname, PROFILE_UI_VERSION } from "./profile.js";
import { HISTORY_VERSION, LocalHistory, HistoryTracker } from "./history.js";
import { attachHistory } from "./history-view.js";
import { PingSound, PING_SOUND_VERSION } from "./ping-sound.js";

const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");
const usersEl = document.querySelector("#users");
const statusEl = document.querySelector("#status");
const availabilityButton = document.querySelector("#availability");
const availabilityState = document.querySelector("#availability-state");
const availabilityControl = document.querySelector("#availability-control");
const nicknameForm = document.querySelector("#nickname-form");
const nicknameInput = document.querySelector("#nickname");
const nicknameSave = document.querySelector("#nickname-save");
const nicknameCancel = document.querySelector("#nickname-cancel");
const nicknameLabel = document.querySelector("#nickname-label");
const nicknameHint = document.querySelector("#nickname-hint");
const nicknameFeedback = document.querySelector("#nickname-feedback");
const pingTime = document.querySelector("#ping-time");
const pingAge = document.querySelector("#ping-age");
const clockEl = document.querySelector("#ping-clock");
const memberCount = document.querySelector("#member-count");
const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const tabStatus = new TabStatus();
const pingSound = new PingSound();
document.body.dataset.soundUi = PING_SOUND_VERSION;
document.body.dataset.tabUi = TAB_UI_VERSION;
document.body.dataset.profileUi = PROFILE_UI_VERSION;
document.body.dataset.profileFlow = "nickname-first-v1";
document.body.dataset.historyUi = HISTORY_VERSION;
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
let pageStopped = false;
let pendingRequestId;
let availabilityBusy = false;
let nicknameBusy = false;
let nicknameDirty = false;
let nicknameEditing = false;
let presenceBusy = false;
let stateBusy = false;
let renderedIds = "";
let config = { pushEnabled: false, vapidPublicKey: null, signalTtlMs: 300000 };
let registrationPromise;
let activity;
const retiredGenerations = new Set();
const seen = new Set();
const visible = () => document.visibilityState !== "hidden";
const focused = () => visible() && document.hasFocus();
const now = () => Date.now() + clockOffset;
const cursor = () => epoch ? `${epoch}:${sequence}` : null;
const presentUsers = () => users.filter((user) => user.online && (user.onlineUntil ?? Infinity) > now());
const me = () => users.find((user) => user.clientId === clientId);
const named = () => Boolean(me()?.nickname?.trim());
function status(message = "") { statusEl.textContent = message; }
function transport(value) {
  ready = value;
  connection.classList.toggle("online", value);
  document.body.dataset.ready = String(value);
  refreshAvailability();
  refreshNickname();
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
  tabStatus.reset();
  pingSound.stop();
  pendingRequestId = undefined;
  if (previous) {
    // A deployment resets the confirmed profile, never the local activity history.
    nicknameEditing = false;
    if (!nicknameDirty) nicknameInput.value = "";
    nicknameFeedback.textContent = "";
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
function unlockAudio() { pingSound.unlock(); }
function alertPing() {
  if (!visible()) return;
  try { navigator.vibrate?.([25, 25, 45]); } catch { /* optional */ }
  pingSound.play();
}
function animatePing() {
  try {
    if (!visible() || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    signalButton.querySelector("span").animate([{ transform: "scale(.92)" }, { transform: "scale(1.07)" }, { transform: "scale(1)" }], { duration: 650, easing: "ease-out" });
  } catch { /* animation is optional */ }
}
function refreshAvailability() {
  const user = me();
  const profileReady = named();
  availabilityControl.hidden = !profileReady;
  availabilityButton.disabled = !ready || availabilityBusy || !profileReady || nicknameBusy || nicknameEditing;
  availabilityButton.setAttribute("aria-busy", String(availabilityBusy));
  availabilityButton.setAttribute("aria-checked", String(user?.available === true));
  availabilityState.textContent = user?.available === true ? "가능" : "불가능";
  // Reading incoming pings and recording history never depend on completing this form.
  signalButton.disabled = !ready || !profileReady || nicknameBusy || nicknameEditing;
}
function refreshNickname() {
  const user = me();
  const hasName = named();
  const expanded = !hasName || nicknameEditing || nicknameBusy;
  nicknameForm.hidden = !expanded;
  document.body.dataset.profileStep = !hasName ? "nickname" : expanded ? "editing" : "ready";
  nicknameLabel.textContent = hasName ? "닉네임 수정" : "닉네임으로 시작";
  nicknameHint.textContent = hasName ? "채널에 표시되는 이름 · 최대 20자" : "닉네임을 적용한 뒤 내 상태를 선택하세요.";
  nicknameCancel.hidden = !hasName;
  nicknameCancel.disabled = nicknameBusy;
  if (user && !nicknameDirty && !nicknameBusy) nicknameInput.value = user.nickname || "";
  nicknameInput.disabled = !ready || !user;
  nicknameInput.readOnly = nicknameBusy;
  nicknameSave.disabled = !ready || !user || nicknameBusy || !nicknameDirty;
  nicknameSave.textContent = nicknameBusy ? "적용 중" : "적용";
  nicknameForm.setAttribute("aria-busy", String(nicknameBusy));
  for (const button of usersEl.querySelectorAll(".user-profile")) {
    button.disabled = !ready || nicknameBusy;
    button.setAttribute("aria-expanded", String(expanded));
  }
}
function editNickname() {
  if (!ready || nicknameBusy) return;
  nicknameEditing = true;
  nicknameDirty = false;
  nicknameInput.value = me()?.nickname || "";
  nicknameFeedback.textContent = "";
  nicknameInput.removeAttribute("aria-invalid");
  refreshNickname();
  refreshAvailability();
  nicknameInput.focus({ preventScroll: true });
  nicknameInput.select();
}
function cancelNickname() {
  if (nicknameBusy || !named()) return;
  nicknameEditing = false;
  nicknameDirty = false;
  nicknameFeedback.textContent = "";
  nicknameInput.removeAttribute("aria-invalid");
  refreshNickname();
  refreshAvailability();
  usersEl.querySelector('.user[data-self="true"] .user-profile')?.focus({ preventScroll: true });
}
nicknameCancel.addEventListener("click", cancelNickname);
usersEl.addEventListener("click", (event) => {
  if (event.target.closest(".user-profile")) editNickname();
});
function refreshTab() {
  if (pageStopped) return;
  const time = now();
  const current = presentUsers();
  const active = current.filter((user) => user.pingUntil > time).length;
  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const tab = tabStatus.view(channelPing, time, current.length, active, focused(), reducedMotion);
  if (document.title !== tab.title) document.title = tab.title;
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && favicon.getAttribute("href") !== tab.icon) favicon.setAttribute("href", tab.icon);
  document.body.dataset.tabUnread = String(tab.unread);
  document.body.dataset.tabCountdown = tab.countdown || "";
  document.body.dataset.tabPulsing = String(tab.pulsing);
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
    const name = document.createElement("bdi");
    name.className = "user-name";
    const label = document.createElement("span");
    label.className = "user-label";
    dot.appendChild(core);
    if (user.clientId === clientId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "user-profile";
      button.setAttribute("aria-controls", "nickname-form");
      button.append(dot, name, label);
      item.appendChild(button);
    } else item.append(dot, name, label);
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
    const available = user.available === true;
    const name = user.nickname || "익명";
    item.dataset.active = String(life > 0);
    item.dataset.online = "true";
    item.dataset.available = String(available);
    item.style.setProperty("--user-life", String(life));
    item.querySelector(".user-name").textContent = name;
    item.querySelector(".user-name").title = name;
    item.querySelector(".user-label").textContent = `${user.clientId === clientId ? "나 · " : ""}${available ? "가능" : "불가능"}`;
    item.setAttribute("aria-label", `${name}${user.clientId === clientId ? " · 나" : ""} · ${available ? "가능" : "불가능"} · 핑 ${life > 0 ? "ON" : "OFF"}`);
    item.querySelector(".user-profile")?.setAttribute("aria-label", `${name} · 내 프로필 수정`);
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
  refreshTab();
  const availableCount = current.filter((user) => user.available === true).length;
  memberCount.textContent = `${current.length}명 · ${availableCount}명 가능`;
  usersEl.setAttribute("aria-label", `${current.length}명 · ${availableCount}명 가능 · ${active}명 핑 ON`);
  refreshAvailability();
  refreshNickname();
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
  try { activity?.signal(signal, generation, users); } catch { /* history never blocks signaling */ }
  tabStatus.notice(signal, clientId, focused(), now());
  drawUsers();
  if (audible && now() - signal.createdAt < 10000 && signal.pingUntil > now()) { alertPing(); animatePing(); }
}
function applyState(state, fromStream = false) {
  if (!Array.isArray(state.users) || !state.epoch) throw new Error("reload_required");
  if (fromStream && generation && state.generation !== generation) return false;
  if (!adoptGeneration(state.generation)) return false;
  if (epoch === state.epoch && (state.revision < revision || state.sequence < sequence)) return false;
  const initial = epoch === null || epoch !== state.epoch;
  if (initial) { epoch = state.epoch; revision = -1; sequence = 0; channelPing = null; seen.clear(); tabStatus.reset(); }
  clockOffset = state.serverTime - Date.now();
  try { activity?.observe(state); } catch { /* optional local recording */ }
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
  if (presenceBusy || pageStopped || navigator.onLine === false) return;
  presenceBusy = true;
  try { applyState(await request(`${api}/presence`, { clientId, sessionId, online: true })); }
  catch (error) { transport(false); showError(error); }
  finally { presenceBusy = false; }
}
async function poll() {
  if (stateBusy || pageStopped || navigator.onLine === false || (streamAlive && Date.now() - lastStreamAt < 15000)) return;
  stateBusy = true;
  try { applyState(await request(`${api}/state`)); }
  catch (error) { transport(false); showError(error); }
  finally { stateBusy = false; }
}
function connectEvents() {
  source?.close();
  streamAlive = false;
  if (pageStopped || navigator.onLine === false || !("EventSource" in globalThis)) return;
  const query = new URLSearchParams({ clientId, sessionId });
  if (cursor()) query.set("since", cursor());
  const current = new EventSource(`${api}/events?${query}`);
  source = current;
  current.addEventListener("users", (event) => {
    if (source !== current || pageStopped) return;
    try {
      if (applyState(JSON.parse(event.data), true)) { streamAlive = true; lastStreamAt = Date.now(); }
    } catch (error) { showError(error); }
  });
  current.addEventListener("signal", (event) => {
    if (source !== current || pageStopped) return;
    try { acceptSignal(JSON.parse(event.data)); lastStreamAt = Date.now(); }
    catch (error) { showError(error); }
  });
  current.onerror = () => { if (source === current) { streamAlive = false; void poll(); } };
}
signalButton.addEventListener("click", async () => {
  if (!ready || !named() || nicknameEditing || nicknameBusy || document.body.classList.contains("sending")) return;
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
  const user = me();
  if (!ready || !named() || nicknameEditing || nicknameBusy || availabilityBusy) return;
  availabilityBusy = true;
  refreshAvailability();
  try {
    const state = await request(`${api}/availability`, { clientId, sessionId, available: user.available !== true });
    applyState(state);
  } catch (error) { showError(error); }
  finally { availabilityBusy = false; refreshAvailability(); }
});
nicknameInput.addEventListener("input", () => {
  nicknameEditing = true;
  nicknameDirty = nicknameInput.value !== (me()?.nickname || "");
  nicknameInput.removeAttribute("aria-invalid");
  nicknameFeedback.textContent = "";
  refreshNickname();
  refreshAvailability();
});
nicknameInput.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    if (event.key === "Enter") event.preventDefault();
    return;
  }
  if (event.key === "Escape" && named()) { event.preventDefault(); cancelNickname(); }
});
nicknameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ready || nicknameBusy || !nicknameDirty) return;
  let name;
  try {
    name = normalizeNickname(nicknameInput.value);
    if (!name) throw new Error("nickname_required");
  } catch (error) {
    nicknameInput.setAttribute("aria-invalid", "true");
    nicknameFeedback.textContent = error.message === "nickname_required" ? "닉네임을 입력하세요."
      : error.message === "nickname_too_long" ? "닉네임은 20자까지 입력" : "사용할 수 없는 문자가 있음";
    return;
  }
  const firstName = !named();
  const submittedGeneration = generation;
  let focusTarget;
  nicknameBusy = true;
  nicknameFeedback.textContent = "";
  refreshNickname();
  refreshAvailability();
  try {
    const state = await request(`${api}/nickname`, { clientId, sessionId, nickname: name });
    applyState(state);
    if (state.generation !== generation || submittedGeneration !== generation) {
      const error = new Error("deployment_changed"); error.generation = state.generation; throw error;
    }
    // A newer snapshot may have arrived while this response was in flight.
    if (me()?.nickname !== name) throw new Error("nickname_conflict");
    if (visible() && nicknameForm.contains(document.activeElement)) {
      focusTarget = firstName ? availabilityButton : usersEl.querySelector('.user[data-self="true"] .user-profile');
    }
    nicknameDirty = false;
    nicknameEditing = false;
    nicknameInput.removeAttribute("aria-invalid");
    nicknameFeedback.textContent = "저장됨";
  } catch (error) {
    nicknameEditing = true;
    if (error.message === "deployment_changed") showError(error);
    nicknameFeedback.textContent = error.message === "nickname_conflict" ? "다른 탭에서 변경됨 · 다시 확인하세요." : "저장 실패 · 다시 시도";
  } finally {
    nicknameBusy = false;
    refreshNickname();
    refreshAvailability();
    focusTarget?.focus({ preventScroll: true });
  }
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
function pause() { pingSound.stop(); source?.close(); source = undefined; streamAlive = false; }
function leave() {
  pageStopped = true;
  pause();
  try {
    navigator.sendBeacon?.(`${api}/presence`, new Blob([JSON.stringify({ clientId, sessionId, online: false })], { type: "application/json" }));
  } catch { /* no beacon needed: lease expiry removes this session */ }
}
function resume() {
  if (pageStopped) return;
  refreshTab();
  connectEvents(); void heartbeat(); void registerPush().catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (!visible()) pingSound.stop();
  refreshTab();
  if (visible()) { refreshDisplay(); resume(); }
});
globalThis.addEventListener("focus", refreshTab);
globalThis.addEventListener("blur", refreshTab);
globalThis.addEventListener("pagehide", leave);
globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted || pageStopped) { pageStopped = false; resume(); }
});
document.addEventListener("freeze", () => { pageStopped = true; pause(); });
document.addEventListener("resume", () => { pageStopped = false; resume(); });
globalThis.addEventListener("online", resume);
globalThis.addEventListener("offline", () => { pause(); transport(false); status("오프라인"); });
try {
  const historyStore = new LocalHistory(roomId, { now });
  activity = new HistoryTracker(historyStore);
  attachHistory(historyStore, document.querySelector(".stage"));
} catch { /* core controls continue even if local recording is unavailable */ }
transport(false);
notifyButton.hidden = true;
connectEvents();
void heartbeat();
void optionalFeatures();
setInterval(() => { if (!pageStopped && visible()) refreshDisplay(); }, 250);
setInterval(refreshTab, 1000);
setInterval(() => void heartbeat(), 15000);
setInterval(() => void poll(), 5000);
