const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");
const presence = document.querySelector("#presence");

const clientId = localStorage.getItem("ping:clientId") ?? crypto.randomUUID();
localStorage.setItem("ping:clientId", clientId);

let activeUntil = 0;
let eventSource;
let expiryTimer;
let fadeFrame;
let audioContext;
let config = { pushEnabled: false, vapidPublicKey: null, signalTtlMs: 300000 };

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
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.42);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(now);
  osc.stop(now + 0.58);
}

function renderPresence(count = 0) {
  const capped = Math.min(Math.max(count, 0), 8);
  presence.replaceChildren();

  for (let i = 0; i < capped; i += 1) {
    const ring = document.createElement("span");
    ring.style.setProperty("--i", i);
    presence.appendChild(ring);
  }

  presence.classList.toggle("empty", capped === 0);
  presence.setAttribute("aria-label", `${count} people in this channel`);
}

function updateFade() {
  cancelAnimationFrame(fadeFrame);

  const tick = () => {
    const remaining = Math.max(0, activeUntil - Date.now());
    const life = Math.min(1, remaining / config.signalTtlMs);
    document.documentElement.style.setProperty("--life", String(life));

    if (remaining > 0) {
      fadeFrame = requestAnimationFrame(tick);
    } else {
      document.body.classList.remove("active");
      document.documentElement.style.setProperty("--life", "0");
    }
  };

  tick();
}

function setActive(until = 0) {
  activeUntil = until;
  const active = until > Date.now();
  document.body.classList.toggle("active", active);

  clearTimeout(expiryTimer);
  if (active) {
    updateFade();
    expiryTimer = setTimeout(() => setActive(0), Math.max(0, until - Date.now()) + 20);
  } else {
    cancelAnimationFrame(fadeFrame);
    document.documentElement.style.setProperty("--life", "0");
  }
}

async function loadState() {
  const response = await fetch(
    `/api/rooms/${encodeURIComponent(roomId)}/state`,
    { cache: "no-store" },
  );
  if (!response.ok) return;

  const state = await response.json();
  setActive(state.active ? state.activeUntil : 0);
  renderPresence(state.presence ?? 0);
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(
    `/api/rooms/${encodeURIComponent(roomId)}/events?clientId=${encodeURIComponent(clientId)}`,
  );

  eventSource.onopen = () => connection.classList.add("online");
  eventSource.onerror = () => connection.classList.remove("online");

  eventSource.addEventListener("state", (event) => {
    const state = JSON.parse(event.data);
    setActive(state.active ? state.activeUntil : 0);
  });

  eventSource.addEventListener("presence", (event) => {
    const state = JSON.parse(event.data);
    renderPresence(state.count ?? 0);
  });

  eventSource.addEventListener("signal", (event) => {
    const state = JSON.parse(event.data);
    setActive(state.active ? state.activeUntil : 0);
    playPing();
    if (navigator.vibrate) navigator.vibrate([25, 25, 45]);
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
    const state = await response.json();
    setActive(state.activeUntil);
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
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadState();
});

void boot();
