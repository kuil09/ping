const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");
const usersEl = document.querySelector("#users");

const clientId = localStorage.getItem("ping:clientId") ?? crypto.randomUUID();
localStorage.setItem("ping:clientId", clientId);

let eventSource;
let audioContext;
let config = { pushEnabled: false, vapidPublicKey: null, signalTtlMs: 300000 };
let users = [];

function unlockAudio() {
  audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") void audioContext.resume();
}

function playPing() {
  unlockAudio();
  if (!audioContext || audioContext.state !== "running") return;

  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(920, now);
  osc.frequency.exponentialRampToValueAtTime(460, now + 0.48);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);

  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + 0.64);
}

function shortId(value) {
  return value.slice(0, 2).toUpperCase();
}

function renderUsers(nextUsers) {
  users = nextUsers;
  usersEl.replaceChildren();

  for (const user of users) {
    const item = document.createElement("div");
    item.className = "user";
    item.dataset.self = String(user.clientId === clientId);
    item.dataset.active = String(user.pingUntil > Date.now());

    const dot = document.createElement("span");
    dot.className = "user-dot";

    const core = document.createElement("span");
    core.className = "user-core";
    core.textContent = shortId(user.clientId);

    dot.appendChild(core);
    item.appendChild(dot);
    usersEl.appendChild(item);
  }

  usersEl.setAttribute("aria-label", `${users.length} people in this channel`);
}

function refreshUserStates() {
  const now = Date.now();
  const items = [...usersEl.querySelectorAll(".user")];

  users.forEach((user, index) => {
    const item = items[index];
    if (!item) return;

    const remaining = Math.max(0, user.pingUntil - now);
    const life = Math.min(1, remaining / config.signalTtlMs);

    item.dataset.active = String(remaining > 0);
    item.style.setProperty("--user-life", String(life));
  });

  requestAnimationFrame(refreshUserStates);
}

async function loadState() {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(roomId)}/state`,
    { cache: "no-store" },
  );
  if (!response.ok) return;

  const state = await response.json();
  renderUsers(state.users ?? []);
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(
    `/api/rooms/${encodeURIComponent(roomId)}/events?clientId=${encodeURIComponent(clientId)}`,
  );

  eventSource.onopen = () => connection.classList.add("online");
  eventSource.onerror = () => connection.classList.remove("online");

  eventSource.addEventListener("users", (event) => {
    const state = JSON.parse(event.data);
    renderUsers(state.users ?? []);
  });

  eventSource.addEventListener("signal", (event) => {
    const signal = JSON.parse(event.data);

    const existing = users.find((user) => user.clientId === signal.clientId);
    if (existing) {
      existing.pingUntil = signal.pingUntil;
      renderUsers(users);
    }

    if (signal.clientId !== clientId) {
      playPing();
      if (navigator.vibrate) navigator.vibrate([25, 25, 45]);
    }
  });
}

signalButton.addEventListener("pointerdown", unlockAudio, { once: true });

signalButton.addEventListener("click", async () => {
  if (document.body.classList.contains("sending")) return;

  document.body.classList.add("sending");
  unlockAudio();
  playPing();
  if (navigator.vibrate) navigator.vibrate(20);

  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/signal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId }),
      },
    );

    if (!response.ok) throw new Error("signal failed");

    const signal = await response.json();
    const existing = users.find((user) => user.clientId === clientId);

    if (existing) {
      existing.pingUntil = signal.pingUntil;
      renderUsers(users);
    }
  } finally {
    document.body.classList.remove("sending");
  }
});

shareButton.addEventListener("click", async () => {
  try {
    if (navigator.share) {
      await navigator.share({ url: location.href });
    } else {
      await navigator.clipboard.writeText(location.href);
      shareButton.classList.add("active");
      setTimeout(() => shareButton.classList.remove("active"), 900);
    }
  } catch {
    // share cancelled
  }
});

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function enablePush() {
  if (
    !config.pushEnabled || !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) return;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
  }

  const response = await fetch(
    `/api/rooms/${encodeURIComponent(roomId)}/subscribe`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, subscription: subscription.toJSON() }),
    },
  );

  if (response.ok) notifyButton.classList.add("active");
}

notifyButton.addEventListener("click", enablePush);

async function boot() {
  document.addEventListener("pointerdown", unlockAudio, { once: true });

  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/sw.js");
  }

  config = await fetch("/api/config", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => config);

  if (!config.pushEnabled) {
    notifyButton.hidden = true;
  } else if (Notification.permission === "granted") {
    notifyButton.classList.add("active");
    void enablePush();
  }

  await loadState();
  connectEvents();
  requestAnimationFrame(refreshUserStates);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadState();
});

void boot();
