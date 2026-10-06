const roomId = location.pathname.split("/").filter(Boolean).at(-1);
const signalButton = document.querySelector("#signal");
const notifyButton = document.querySelector("#notify");
const shareButton = document.querySelector("#share");
const connection = document.querySelector("#connection");

const clientId = localStorage.getItem("ping:clientId") ?? crypto.randomUUID();
localStorage.setItem("ping:clientId", clientId);

let activeUntil = 0;
let eventSource;
let expiryTimer;
let config = { pushEnabled: false, vapidPublicKey: null };

function setActive(until = 0) {
  activeUntil = until;
  const active = until > Date.now();
  document.body.classList.toggle("active", active);

  clearTimeout(expiryTimer);
  if (active) {
    expiryTimer = setTimeout(() => setActive(0), Math.max(0, until - Date.now()) + 20);
  }
}

async function loadState() {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/state`, { cache: "no-store" });
  if (!response.ok) return;
  const state = await response.json();
  setActive(state.active ? state.activeUntil : 0);
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events`);

  eventSource.onopen = () => connection.classList.add("online");
  eventSource.onerror = () => connection.classList.remove("online");

  for (const eventName of ["state", "signal"]) {
    eventSource.addEventListener(eventName, (event) => {
      const state = JSON.parse(event.data);
      setActive(state.active ? state.activeUntil : 0);
      if (eventName === "signal" && navigator.vibrate) navigator.vibrate(35);
    });
  }
}

signalButton.addEventListener("click", async () => {
  if (document.body.classList.contains("sending")) return;

  document.body.classList.add("sending");
  if (navigator.vibrate) navigator.vibrate(20);

  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
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
  if (!config.pushEnabled || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

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

  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, subscription: subscription.toJSON() }),
  });

  if (response.ok) notifyButton.classList.add("active");
}

notifyButton.addEventListener("click", enablePush);

async function boot() {
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
