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
  })
    .then(drain)
    .catch(() => {});
}

/** Read and discard the reply. An unread body keeps its connection occupied. */
export function drain(res) {
  try {
    return res.arrayBuffer().catch(() => {});
  } catch {
    return undefined;
  }
}

/**
 * Tell the server we are alive and which version we have drawn.
 *
 * Two things this must not do over a two-hour draft. It must not let requests
 * pile up if the server ever stalls, so a beat is skipped while one is still in
 * flight and every one has a hard timeout. And it must read the reply, because
 * an unread response body holds its connection open.
 */
export function heartbeat(display, getVersion, getBuild = () => "") {
  let inFlight = false;
  setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 4000);
    try {
      const res = await fetch(
        "/api/ack?display=" + display + "&v=" + getVersion() + "&build=" + encodeURIComponent(getBuild()),
        { signal: stop.signal },
      );
      await drain(res);
    } catch {
      // The status page shows the connection state; a missed beat is not news.
    } finally {
      clearTimeout(timer);
      inFlight = false;
    }
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
