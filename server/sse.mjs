// Server-sent events to the two TV windows.
//
// A TV that reloads, or a laptop that hiccups, must not lose the show. Every
// message carries a sequence number and the last thousand are kept, so a browser
// reconnecting with Last-Event-ID gets exactly what it missed instead of a full
// refresh. If it has been away too long it gets a complete snapshot instead.
//
// Each display subscribes only to what it draws. The board does not need reveal
// timings and the studio does not need clock ticks.

const TOPICS = {
  board: new Set(["hello", "pick", "correction", "gap", "onclock", "clock", "status", "launch", "reload"]),
  studio: new Set(["hello", "preload", "reveal", "revealcut", "revealdone", "catchup", "say", "status", "launch", "reload"]),
  ops: null, // everything
};

export function createSse({ state, ringSize = 1000, heartbeatMs = 15000 }) {
  const clients = new Set();
  const ring = [];

  function remember(entry) {
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
  }

  function frame(id, event, data) {
    const payload = typeof data === "string" ? data : JSON.stringify(data ?? {});
    return (id ? "id: " + id + "\n" : "") + "event: " + event + "\ndata: " + payload + "\n\n";
  }

  /**
   * Publish to every display that cares.
   * `volatile` events (clock ticks) are re-derivable, so they get no sequence
   * number and are dropped rather than queued behind a slow socket.
   */
  function send(event, data, { volatile = false } = {}) {
    const id = volatile ? 0 : state.nextSeq();
    const entry = { seq: id, event, data };
    if (!volatile) remember(entry);
    const text = frame(id, event, data);
    for (const c of clients) {
      if (c.topics && !c.topics.has(event)) continue;
      if (volatile && c.res.writableLength > 65536) continue; // shed, never block
      write(c, text);
    }
    return id;
  }

  function write(c, text) {
    try {
      c.res.write(text);
      c.lastWrite = Date.now();
    } catch {
      drop(c);
    }
  }

  function drop(c) {
    clients.delete(c);
    try {
      c.res.end();
    } catch {}
  }

  function attach(req, res, { display = "ops", hello }) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const c = { res, display, topics: TOPICS[display] ?? null, lastWrite: Date.now(), at: Date.now() };
    clients.add(c);

    // Replay what this browser missed, if we still have it.
    const since = Number(req.headers["last-event-id"] ?? 0);
    const oldest = ring.length ? ring[0].seq : 0;
    if (since && ring.length && since >= oldest - 1) {
      for (const e of ring) {
        if (e.seq <= since) continue;
        if (c.topics && !c.topics.has(e.event)) continue;
        write(c, frame(e.seq, e.event, e.data));
      }
    } else {
      write(c, frame(state.nextSeq(), "hello", hello()));
    }

    req.on("close", () => clients.delete(c));
    return c;
  }

  const beat = setInterval(() => {
    for (const c of clients) {
      if (Date.now() - c.lastWrite < heartbeatMs) continue;
      write(c, ": heartbeat\n\n");
    }
  }, heartbeatMs);
  beat.unref?.();

  return {
    attach,
    send,
    close() {
      clearInterval(beat);
      for (const c of [...clients]) drop(c);
    },
    get count() {
      return clients.size;
    },
    counts() {
      const out = {};
      for (const c of clients) out[c.display] = (out[c.display] ?? 0) + 1;
      return out;
    },
  };
}
