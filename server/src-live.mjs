// The real ESPN draft wire.
//
// Same shape as the replay source, so everything downstream is identical on the
// night and in rehearsal. What this adds over the console watcher it grew from:
//
//   - a fresh draftSecurity token before EVERY attempt, because it is short-lived
//   - backoff with jitter that resets once a connection actually succeeds
//   - a watchdog. CLOCK arrives about every five seconds, so silence means a
//     half-open socket. A dropped Wi-Fi link often does NOT emit close, and the
//     watcher this replaced would have sat there quietly forever
//   - round-trip time off the PONG frames, the earliest sign the link is dying
//   - a reconnect scheduled through a catch, so a failed token fetch inside a
//     timer cannot become an unhandled rejection and take down the show
//
// Never log what we send: client frames carry the Disney access token.

import { connectDraft, draftToken, joinUrl } from "./draftwire.mjs";

const BACKOFF = [500, 1000, 2000, 4000, 8000];
const SILENCE_MS = 45000;

export function createLiveSource({
  leagueId,
  teamId,
  swid,
  cookie,
  season = 2026,
  onFrame = () => {},
  onEvent = () => {},
  onRtt = () => {},
  watchdogMs = SILENCE_MS,
}) {
  let conn = null;
  let attempt = 0;
  let stopped = false;
  let retryTimer = null;
  let watchdog = null;
  let lastFrameAt = 0;
  let connectedOnce = false;

  function armWatchdog() {
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (stopped || !lastFrameAt) return;
      if (Date.now() - lastFrameAt < watchdogMs) return;
      // Silence this long means the socket is half-open. Close it ourselves;
      // waiting for a close event that will never arrive is how a show dies.
      onEvent("error", `no frame for ${Math.round((Date.now() - lastFrameAt) / 1000)}s - forcing a reconnect`);
      lastFrameAt = 0;
      try {
        conn?.close();
      } catch {}
      scheduleRetry();
    }, 5000);
    watchdog.unref?.();
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect().catch((e) => {
        onEvent("error", "reconnect failed: " + e.message);
        scheduleRetry();
      });
    }, wait);
    retryTimer.unref?.();
    onEvent("info", `reconnecting in ${wait}ms (attempt ${attempt + 1})`);
  }

  async function connect() {
    if (stopped) return;
    attempt++;
    let token;
    try {
      token = await draftToken({ leagueId, teamId, cookie, season });
    } catch (e) {
      // A 401 here is the one mid-draft failure the operator can actually fix.
      const expired = /40[13]/.test(e.message);
      onEvent("error", expired ? "cookies expired - paste fresh ones and reload the environment" : "token: " + e.message);
      scheduleRetry();
      return;
    }

    const url = joinUrl({ leagueId, teamId, swid, token });
    conn = connectDraft({
      url,
      onEvent: (kind, detail) => {
        if (kind === "open") {
          attempt = 0;
          connectedOnce = true;
          lastFrameAt = Date.now();
          armWatchdog();
        }
        if (kind === "close" && !stopped) scheduleRetry();
        onEvent(kind, detail);
      },
      onFrame: (frame) => {
        lastFrameAt = Date.now();
        if (frame.cmd === "PONG" && frame.sentAt) onRtt(Date.now() - frame.sentAt);
        onFrame(frame);
      },
    });
  }

  return {
    name: "live:" + leagueId + "/team" + teamId,
    simulated: false,
    meta: { source: "live", leagueId, teamId },
    async start() {
      await connect();
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      try {
        conn?.close();
      } catch {}
    },
    get healthy() {
      return connectedOnce && lastFrameAt > 0 && Date.now() - lastFrameAt < watchdogMs;
    },
    get lastFrameAt() {
      return lastFrameAt;
    },
  };
}
