// ESPN draft-room wire client. What the draft room page does, without the page:
//   1. GET  .../leagues/<L>/teams/<T>/draftSecurity  (member cookies) -> numeric token
//   2. WS   wss://fantasydraft.espn.com/game-1/league-<L>/JOIN?...     -> text frames
// Frames are "<CMD> <args...>": INIT, TOKEN, JOINED, AUTODRAFT, CLOCK, SELECTING,
// SELECTED, AUTOSUGGEST, STATE, BID, PONG (see docs/SPIKE-RESULTS.md). Client sends
// "PING PING%20<ms>" as keepalive; the server answers PONG. Never log what we send.

const GAME = 1; // ffl

export async function draftToken({ leagueId, teamId, cookie, season = 2026 }) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}/teams/${teamId}/draftSecurity`;
  const r = await fetch(url, { headers: { accept: "application/json", cookie } });
  if (!r.ok) throw new Error("draftSecurity HTTP " + r.status);
  const text = (await r.text()).trim();
  return text.replace(/^"|"$/g, "");
}

export function joinUrl({ leagueId, teamId, swid, token, tokenPrefix = GAME }) {
  const u = new URL(`wss://fantasydraft.espn.com/game-${GAME}/league-${leagueId}/JOIN`);
  u.searchParams.set("1", String(GAME));
  u.searchParams.set("2", String(leagueId));
  u.searchParams.set("3", String(teamId));
  u.searchParams.set("4", swid);
  u.searchParams.set("5", `${tokenPrefix}:${leagueId}:${teamId}:${swid}:${token}`);
  u.searchParams.set("6", "false");
  u.searchParams.set("7", "false");
  u.searchParams.set("8", "KONA");
  u.searchParams.set("nocache", String(Date.now() % 1000000));
  return u.toString();
}

export function parseFrame(text) {
  const sp = text.indexOf(" ");
  const cmd = sp < 0 ? text : text.slice(0, sp);
  const rest = sp < 0 ? "" : text.slice(sp + 1);
  const args = rest ? rest.split(" ") : [];
  const f = { cmd, args, raw: text };
  switch (cmd) {
    case "SELECTED":
      return { ...f, teamId: +args[0], playerId: +args[1], slot: +args[2], memberId: args[3] };
    case "SELECTING":
      return { ...f, teamId: +args[0], clockMs: +args[1] };
    case "CLOCK":
      return { ...f, a: +args[0], msLeft: +args[1], teamId: +args[2] };
    case "AUTODRAFT":
      return { ...f, teamId: +args[0], on: args[1] === "true" };
    case "AUTOSUGGEST":
      return { ...f, playerId: +args[0] };
    case "JOINED":
      return { ...f, teamId: +args[0], memberId: args[1] };
    case "STATE":
      return { ...f, state: +args[0] };
    case "BID":
      return { ...f, teamId: +args[0], playerId: +args[1], amount: +args[2], msLeft: +args[4] };
    case "INIT":
      return { ...f, bytes: Buffer.from(rest.replace(/\s+/g, ""), "base64") };
    default:
      return f;
  }
}

/** Open the draft wire. Calls onFrame(parsed) for every server frame, onEvent for
 *  lifecycle ("open" | "close" | "error", detail). Returns { close() }. */
export function connectDraft({ url, onFrame, onEvent = () => {}, pingMs = 10000 }) {
  const ws = new WebSocket(url);
  let ping = null;
  ws.addEventListener("open", () => {
    onEvent("open", url.replace(/4=[^&]+/, "4=<swid>").replace(/5=[^&]+/, "5=<token>"));
    ping = setInterval(() => {
      if (ws.readyState === 1) ws.send("PING PING%20" + Date.now());
    }, pingMs);
  });
  ws.addEventListener("message", (m) => {
    const text = typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8");
    try {
      onFrame(parseFrame(text));
    } catch (e) {
      onEvent("error", "frame handler: " + e.message);
    }
  });
  ws.addEventListener("close", (e) => {
    clearInterval(ping);
    onEvent("close", e.code + " " + (e.reason || ""));
  });
  ws.addEventListener("error", (e) => onEvent("error", e.message || String(e)));
  return { close: () => ws.close(), ws };
}
