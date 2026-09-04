// Shared TV-window plumbing: the event stream, display registration, keeping the
// screen awake. Every page includes this before its own script.
//
// EventSource reconnects on its own and sends Last-Event-ID for us, so a reload
// or a hiccup replays exactly what was missed. The one rule these pages follow:
// a lost connection never clears what is already drawn.

export function connect(display, handlers) {
  const es = new EventSource("/events?display=" + display);
  const status = { connected: false, since: Date.now(), version: 0 };

  es.onopen = () => {
    status.connected = true;
    status.since = Date.now();
    handlers.onConnection?.(status);
  };
  es.onerror = () => {
    status.connected = false;
    handlers.onConnection?.(status);
  };
  for (const [event, fn] of Object.entries(handlers)) {
    if (event.startsWith("on")) continue;
    es.addEventListener(event, (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {}
      if (data && typeof data.version === "number") status.version = data.version;
      fn(data, e);
    });
  }
  return { es, status };
}

export function register(display, extra = {}) {
  const body = {
    display,
    screen: window.screen.width + "x" + window.screen.height,
    fullscreen: !!document.fullscreenElement || window.innerHeight >= window.screen.height - 2,
    ...extra,
  };
  return fetch("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** Tell the server we are alive and which version we have drawn. */
export function heartbeat(display, getVersion, getBuild = () => "") {
  setInterval(() => {
    fetch("/api/ack?display=" + display + "&v=" + getVersion() + "&build=" + encodeURIComponent(getBuild())).catch(() => {});
  }, 2000);
}

/** Stop the TV blanking mid-draft. */
export async function keepAwake() {
  const ask = async () => {
    try {
      await navigator.wakeLock?.request("screen");
    } catch {}
  };
  await ask();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ask();
  });
}

export const POS_CLASS = (pos) =>
  ({ QB: "qb", RB: "rb", WR: "wr", TE: "te", K: "k", "D/ST": "dst" })[pos] || "unk";
