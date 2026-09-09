// The draft room itself, read over the shoulder of the browser showing it.
//
// This is how the 8/29 capture worked, and why it survived a whole draft without
// being disturbed: there is only ever ONE connection to the room, the page's own,
// and we listen to it. We never open a second one.
//
// That distinction turned out to matter. ESPN appears to allow one draft-room
// connection per member, so a separate client joining with the same account
// evicts whoever is actually drafting. Here that cannot happen by construction:
// the window this opens IS the draft room, the owner drafts in it, and the show
// reads the frames it was already receiving.
//
// Frames arrive already parsed, exactly as the direct wire client produces them,
// so everything downstream is identical.
//
// We read only what the server sends. Frames the page SENDS carry an access
// token and are never touched.

import { chromium } from "playwright-core";
import { parseFrame } from "./draftwire.mjs";

const ROOM_URL = ({ leagueId, teamId, swid, season }) =>
  `https://fantasy.espn.com/football/draft?leagueId=${leagueId}&seasonId=${season}&teamId=${teamId}` +
  (swid ? `&memberId=${encodeURIComponent(swid)}` : "");

// The page opens more than one socket; the draft is on this host. The other is
// Disney telemetry and is ignored.
const IS_DRAFT_SOCKET = (url) => /fantasydraft\.espn\.com/i.test(url);

export function createRoomSource({
  leagueId,
  teamId,
  swid,
  season = 2026,
  profileDir = "data/chrome-profile",
  headless = false,
  onFrame = () => {},
  onEvent = () => {},
} = {}) {
  let ctx = null;
  let page = null;
  let closed = false;
  let sawSocket = false;
  let frames = 0;
  let relaunchTimer = null;

  function watch(p) {
    // Once per page. Attaching twice made every frame arrive twice.
    if (p.__watched) return;
    p.__watched = true;
    p.on("websocket", (ws) => {
      if (!IS_DRAFT_SOCKET(ws.url())) return;
      sawSocket = true;
      onEvent("open", "reading the draft room socket");

      ws.on("framereceived", (f) => {
        // Only ever the server's half. The page's own frames carry a token.
        const text = typeof f.payload === "string" ? f.payload : String(f.payload ?? "");
        if (!text) return;
        frames++;
        try {
          onFrame(parseFrame(text));
        } catch (e) {
          onEvent("error", "frame: " + e.message);
        }
      });

      ws.on("close", () => {
        if (closed) return;
        onEvent("close", "the draft room socket closed");
      });
      ws.on("socketerror", (e) => onEvent("error", "socket: " + e));
    });

    p.on("close", () => {
      if (closed) return;
      onEvent("close", "the draft room window was closed");
      scheduleRelaunch();
    });
  }

  function scheduleRelaunch() {
    if (closed || relaunchTimer) return;
    relaunchTimer = setTimeout(() => {
      relaunchTimer = null;
      launch().catch((e) => {
        onEvent("error", "could not reopen the draft room: " + e.message);
        scheduleRelaunch();
      });
    }, 3000);
  }

  async function launch() {
    if (closed) return;
    if (!ctx) {
      ctx = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome",
        headless,
        viewport: null,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--start-maximized", "--hide-crash-restore-bubble"],
      });
      // A profile that was killed rather than closed comes back with its old
      // tabs restored, and a restored draft-room tab is a second connection
      // from the same member: ESPN then evicts one of them. Keep exactly one
      // page, and make it the one we navigate.
      const extra = ctx.pages().slice(1);
      for (const p of extra) await p.close().catch(() => {});
      if (extra.length) onEvent("info", "closed " + extra.length + " restored tab(s) so the room has one connection");
      ctx.on("page", watch);
    }
    page = ctx.pages()[0] ?? (await ctx.newPage());
    watch(page);
    const url = ROOM_URL({ leagueId, teamId, swid, season });
    onEvent("info", "opening the draft room for team " + teamId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // If ESPN wants a login, the window is right there for a person to use.
    setTimeout(() => {
      if (!sawSocket && !closed) {
        onEvent("error", "no draft-room socket yet. If the window is asking you to sign in, do it - the session is remembered.");
      }
    }, 20000);
  }

  return {
    name: "room:" + leagueId + "/team" + teamId,
    simulated: false,
    meta: { source: "room", leagueId, teamId },
    async start() {
      await launch();
    },
    async close() {
      closed = true;
      clearTimeout(relaunchTimer);
      try {
        await ctx?.close();
      } catch {}
    },
    get healthy() {
      return sawSocket && frames > 0;
    },
    get frames() {
      return frames;
    },
    /** The page, for the launch gate to confirm the room is actually up. */
    get page() {
      return page;
    },
  };
}
