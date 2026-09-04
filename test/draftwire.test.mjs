// The wire client against a real WebSocket server, on localhost.
//
// The live path is the one thing that cannot be rehearsed without ESPN, so the
// transport half is worth proving on its own: that it connects, that it sends
// the headers a browser would send, that frames arrive parsed, that the
// keepalive goes out, and that closing is clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { connectDraft } from "../server/draftwire.mjs";

/** A throwaway room that records what the client sent it. */
async function room() {
  const http = createServer();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  const wss = new WebSocketServer({ server: http });
  const seen = { headers: null, sent: [] };
  const sockets = new Set();

  wss.on("connection", (ws, req) => {
    seen.headers = req.headers;
    sockets.add(ws);
    ws.on("message", (m) => seen.sent.push(String(m)));
    ws.on("close", () => sockets.delete(ws));
  });

  return {
    url: "ws://127.0.0.1:" + port + "/JOIN",
    seen,
    send: (text) => {
      for (const ws of sockets) ws.send(text);
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

test("it connects and hands back parsed frames", async () => {
  const r = await room();
  const frames = [];
  const events = [];
  const conn = connectDraft({
    url: r.url,
    onFrame: (f) => frames.push(f),
    onEvent: (kind, detail) => events.push(kind + " " + detail),
  });
  await settle(250);

  r.send("SELECTED 7 4362628 3");
  r.send("SELECTING 8 90000");
  r.send("STATE 2");
  await settle(250);
  conn.close();
  await settle(120);
  await r.close();

  assert.ok(events.some((e) => e.startsWith("open")), "it opened");
  const pick = frames.find((f) => f.cmd === "SELECTED");
  assert.equal(pick.teamId, 7);
  assert.equal(pick.playerId, 4362628);
  assert.equal(pick.slot, 3);
  assert.equal(frames.find((f) => f.cmd === "SELECTING").clockMs, 90000);
  assert.equal(frames.find((f) => f.cmd === "STATE").state, 2);
});

test("it presents itself the way the draft room page does", async () => {
  // Node's built-in WebSocket sends no Origin header at all. If ESPN checks for
  // one, that is the difference between the show working and not.
  const r = await room();
  const conn = connectDraft({
    url: r.url,
    cookie: "SWID={test}; espn_s2=abc",
    onFrame: () => {},
  });
  await settle(300);
  conn.close();
  await settle(120);
  const headers = r.seen.headers;
  await r.close();

  assert.equal(headers.origin, "https://fantasy.espn.com");
  assert.match(headers["user-agent"] ?? "", /Mozilla/);
  assert.equal(headers.cookie, "SWID={test}; espn_s2=abc");
});

test("no cookie is sent when none is given", async () => {
  const r = await room();
  const conn = connectDraft({ url: r.url, onFrame: () => {} });
  await settle(300);
  conn.close();
  await settle(120);
  const headers = r.seen.headers;
  await r.close();
  assert.equal(headers.cookie, undefined);
});

test("the keepalive goes out on its own", async () => {
  const r = await room();
  const conn = connectDraft({ url: r.url, onFrame: () => {}, pingMs: 60 });
  await settle(400);
  conn.close();
  await settle(120);
  const sent = [...r.seen.sent];
  await r.close();
  assert.ok(sent.length >= 2, "several pings went out, got " + sent.length);
  assert.ok(sent.every((s) => s.startsWith("PING ")), "and they are pings");
});

test("a frame handler that throws is reported, not fatal", async () => {
  const r = await room();
  const events = [];
  const conn = connectDraft({
    url: r.url,
    onFrame: () => {
      throw new Error("handler exploded");
    },
    onEvent: (kind, detail) => events.push(kind + ": " + detail),
  });
  await settle(250);
  r.send("SELECTED 1 2 3");
  await settle(250);
  conn.close();
  await settle(120);
  await r.close();
  assert.ok(events.some((e) => e.includes("handler exploded")), "it was reported");
});

test("closing stops the keepalive rather than leaving a timer running", async () => {
  const r = await room();
  const conn = connectDraft({ url: r.url, onFrame: () => {}, pingMs: 50 });
  await settle(250);
  conn.close();
  await settle(150);
  const after = r.seen.sent.length;
  await settle(300);
  const later = r.seen.sent.length;
  await r.close();
  assert.equal(later, after, "nothing was sent after close");
});
