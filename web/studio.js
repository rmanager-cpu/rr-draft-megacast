import { connect, drain, heartbeat, keepAwake, POS_CLASS, register } from "./common.js";

const standby = document.getElementById("standby");
const nextUp = document.getElementById("nextup");
const sting = document.getElementById("sting");
const stingNo = document.getElementById("stingno");
const cardEl = document.getElementById("card");
const shotImg = document.getElementById("shot");
const fallback = document.getElementById("fallback");
const bar = document.querySelector("#bar i");
const catchup = document.getElementById("catchup");
const slate = document.getElementById("slate");
const queueEl = document.getElementById("queue");
const clipBox = document.getElementById("clip");
const clipTag = document.getElementById("cliptag");
const arm = document.getElementById("arm");
const down = document.getElementById("down");

let version = 0;
let buildId = "";
let skew = 0; // serverTime minus our clock, so a deadline means the same on both sides
let current = null;
let raf = null;
let catchupTimer = null;

const serverNow = () => Date.now() + skew;
const shotUrl = (c) => "/img/headshot/" + c.playerId + (c.proTeam ? "?team=" + encodeURIComponent(c.proTeam) : "");

// Start the image fetch the moment a pick commits, not when its reveal begins.
//
// Capped, because a catch-up after a dropout can commit thirty picks at once and
// Chrome only opens six connections to one host. Thirty images queued in front
// of the heartbeat is how a page slowly runs out of room over a long draft.
const preloadQueue = [];
let preloading = 0;

function preload(playerId, proTeam) {
  preloadQueue.push(shotUrl({ playerId, proTeam }));
  pumpPreload();
}

function pumpPreload() {
  while (preloading < 2 && preloadQueue.length) {
    const url = preloadQueue.shift();
    preloading++;
    const img = new Image();
    const done = () => {
      preloading--;
      pumpPreload();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
  }
}

function initials(c) {
  if (c.pos === "D/ST") return String(c.lastName || "").slice(0, 3).toUpperCase();
  const f = String(c.firstName || " ").charAt(0);
  const l = String(c.lastName || " ").charAt(0);
  return (f + l).toUpperCase();
}

function showCard(e) {
  const c = e.card;
  const phases = e.phases;
  current = { ...e, card: c };

  const root = document.documentElement.style;
  root.setProperty("--sting", phases.stingMs + "ms");
  root.setProperty("--cardin", phases.cardInMs + "ms");
  root.setProperty("--cardout", phases.outMs + "ms");
  root.setProperty("--accent", "var(--" + POS_CLASS(c.pos) + ")");

  standby.style.display = "none";
  catchup.classList.remove("show");

  slate.textContent = "Round " + c.round + "  Pick " + String(c.slotInRound).padStart(2, "0") + "   - #" + c.pick + " overall";
  queueEl.textContent = e.queueDepth > 0 ? e.queueDepth + " waiting" : "";

  stingNo.textContent = c.round + "." + String(c.slotInRound).padStart(2, "0");
  sting.classList.remove("run");
  void sting.offsetWidth;
  if (phases.stingMs > 0) sting.classList.add("run");

  cardEl.querySelector(".meta").textContent = "Round " + c.round + ", Pick " + c.slotInRound;
  cardEl.querySelector(".first").textContent = c.firstName || "";
  const last = cardEl.querySelector(".last");
  last.textContent = c.lastName || c.name;
  if (c.suffix) {
    const s = document.createElement("span");
    s.className = "sfx";
    s.textContent = " " + c.suffix;
    last.append(s);
  }
  cardEl.querySelector(".pill").textContent = c.pos;
  cardEl.querySelector(".team").textContent = c.proTeam || "";
  cardEl.querySelector(".adp").textContent = c.adp ? "ADP " + c.adp : "";
  cardEl.querySelector(".to b").textContent = c.teamName || "";
  cardEl.querySelector(".mgr").textContent = c.manager || "";

  // The fallback sits behind a fixed-size box, so a headshot that never arrives
  // cannot move the layout by a pixel.
  fallback.textContent = initials(c);
  shotImg.classList.remove("ready");
  shotImg.removeAttribute("src");
  shotImg.onload = () => shotImg.classList.add("ready");
  shotImg.onerror = () => shotImg.classList.remove("ready");
  shotImg.src = shotUrl(c);

  cardEl.classList.remove("out", "in");
  void cardEl.offsetWidth;
  setTimeout(() => cardEl.classList.add("in"), phases.stingMs);

  // Cards-only mode never reaches for a clip; there is no time for one.
  if (e.mode !== "card" && e.content) {
    setTimeout(() => playClip(e.content, c, e.content.ceilingMs), phases.stingMs + phases.cardInMs);
  } else {
    stopClip();
  }

  tick();
}

// ---------------------------------------------------------------- the clip
//
// The ladder, in order: the clip plays, or it does not start in time, or the
// player never loads at all. Every rung lands on the card, which is already on
// screen underneath. Nothing here can delay or replace the card.
const CLIP_READY_MS = 1800;
let ytPlayer = null;
let ytReady = false;
let clipTimer = null;

function loadYouTube() {
  if (window.YT?.Player || document.getElementById("ytapi")) return;
  const s = document.createElement("script");
  s.id = "ytapi";
  s.src = "https://www.youtube.com/iframe_api";
  s.onerror = () => {
    ytReady = false;
  };
  document.head.append(s);
}
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
};

function stopClip() {
  clearTimeout(clipTimer);
  clipBox.classList.remove("live");
  clipTag.classList.remove("live");
  try {
    ytPlayer?.stopVideo?.();
  } catch {}
  // A video element keeps decoding unless it is told to stop.
  for (const v of clipBox.querySelectorAll("video")) {
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {}
  }
}

// A pre-roll advert reports itself as PLAYING, so "playing" is not enough to put
// something on a television in front of twelve people. The advert runs on its own
// timeline, so the real video is only up when the playhead is where we asked for
// it AND moving. Until both are true the card stays, which is no loss: the card
// was already on screen and is what the clip sits on top of.
// How long to keep waiting for the real video. A pre-roll advert can be ten or
// fifteen seconds, and waiting it out costs nothing visible, because the card is
// already on screen and stays there. So wait as long as the reveal can spare
// while still leaving a few seconds of clip worth showing - and no longer, since
// a card that sits doing nothing is its own kind of wrong.
const CONFIRM_MIN_MS = 2500;
const CONFIRM_MAX_MS = 12000;
const CLIP_WORTH_SHOWING_MS = 3500;

function confirmWindow() {
  const left = (current?.endsAt ?? 0) - serverNow();
  const spare = left - CLIP_WORTH_SHOWING_MS;
  return Math.max(CONFIRM_MIN_MS, Math.min(CONFIRM_MAX_MS, spare));
}

function confirmRealVideo(player, startSec, ceilingMs) {
  const deadline = Date.now() + confirmWindow();
  let previous = -1;

  const check = () => {
    if (!current) return;
    let t = 0;
    try {
      t = player.getCurrentTime();
    } catch {
      stopClip();
      return;
    }
    const atTheRightPlace = t >= startSec - 2;
    const moving = previous >= 0 && t > previous;
    if (atTheRightPlace && moving) {
      clearTimeout(clipTimer);
      clipBox.classList.add("live");
      clipTag.classList.add("live");
      // Length is a ceiling, and the reveal may already have been shortened.
      const budget = Math.min(ceilingMs ?? 8000, Math.max(0, (current?.endsAt ?? 0) - serverNow()));
      clipTimer = setTimeout(stopClip, Math.max(1200, budget));
      return;
    }
    previous = t;
    if (Date.now() > deadline) {
      // Most likely an advert, or a video that will not start. Stay on the card.
      stopClip();
      return;
    }
    setTimeout(check, 300);
  };
  check();
}
function playClip(content, card, ceilingMs) {
  stopClip();
  if (!content) return;

  // A file on this disk starts on the next frame. No player to load, no
  // negotiation, no advert, nothing to wait for and nothing to go wrong.
  if (content.kind === "file") return playFile(content, card, ceilingMs);

  if (content.kind !== "video" || !ytReady || !window.YT?.Player) return;

  const mount = document.createElement("div");
  clipBox.replaceChildren(mount);
  clipTag.textContent = card.lastName || card.name;

  // If it has not actually started inside the window, give up and stay on the
  // card. Silence and a card beat a black rectangle.
  clipTimer = setTimeout(stopClip, CLIP_READY_MS + CONFIRM_MAX_MS);

  try {
    ytPlayer = new window.YT.Player(mount, {
      videoId: content.videoId,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        start: content.startSec || 0,
        mute: 1,
      },
      events: {
        onReady: (e) => {
          try {
            e.target.mute();
            e.target.playVideo();
          } catch {}
        },
        onStateChange: (e) => {
          if (e.data !== window.YT.PlayerState.PLAYING) return;
          confirmRealVideo(e.target, content.startSec || 0, ceilingMs);
        },
        onError: stopClip,
      },
    });
  } catch {
    stopClip();
  }
}

function playFile(content, card, ceilingMs) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = content.url;
  clipBox.replaceChildren(v);
  clipTag.textContent = card.lastName || card.name;

  const show = () => {
    clearTimeout(clipTimer);
    clipBox.classList.add("live");
    clipTag.classList.add("live");
    const budget = Math.min(ceilingMs ?? 8000, Math.max(0, (current?.endsAt ?? 0) - serverNow()));
    clipTimer = setTimeout(stopClip, Math.max(1200, budget));
  };

  // Only once frames are actually being drawn, same rule as the embed.
  v.addEventListener("playing", show, { once: true });
  v.addEventListener("error", stopClip, { once: true });

  const start = content.startSec || 0;
  const go = () => {
    try {
      if (start > 0 && Math.abs(v.currentTime - start) > 0.5) v.currentTime = start;
      v.play().catch(stopClip);
    } catch {
      stopClip();
    }
  };
  if (v.readyState >= 1) go();
  else v.addEventListener("loadedmetadata", go, { once: true });

  clearTimeout(clipTimer);
  clipTimer = setTimeout(stopClip, CLIP_READY_MS + 1500);
}

function tick() {
  cancelAnimationFrame(raf);
  const step = () => {
    if (!current) return;
    const total = Math.max(1, current.endsAt - current.startsAt);
    const left = current.endsAt - serverNow();
    bar.style.width = Math.max(0, Math.min(100, (1 - left / total) * 100)) + "%";
    if (left > 0) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

function hideCard() {
  stopClip();
  cardEl.classList.remove("in");
  cardEl.classList.add("out");
  current = null;
  cancelAnimationFrame(raf);
  setTimeout(() => {
    if (current) return;
    standby.style.display = "";
    slate.textContent = "";
    queueEl.textContent = "";
    bar.style.width = "0";
  }, 420);
}

connect("studio", {
  hello: (d) => {
    version = d.version;
    buildId = d.buildId || "";
    skew = (d.serverTime || Date.now()) - Date.now();
    if (d.reveal && d.reveal.card) {
      // A TV that just reloaded picks the card back up with its time remaining.
      showCard({
        card: d.reveal.card,
        phases: { stingMs: 0, cardInMs: 300, outMs: 400 },
        startsAt: serverNow() - 1,
        endsAt: d.reveal.endsAt,
        queueDepth: d.reveal.queueDepth || 0,
        mode: d.reveal.mode,
      });
    }
    if (d.onClock && d.league) {
      const t = (d.league.teams || []).find((x) => x.id === d.onClock.teamId);
      nextUp.textContent = t ? "on the clock: " + t.name : "";
    }
  },
  preload: (d) => preload(d.playerId, d.proTeam),
  reveal: (d) => {
    version = d.version || version;
    skew = (d.serverTime || Date.now()) - Date.now();
    showCard(d);
  },
  revealcut: (d) => {
    if (!current || current.card.pick !== d.pick) return;
    current.endsAt = d.endsAt;
    // Picks are waiting, so the clip goes first. The card is what must survive.
    stopClip();
    queueEl.textContent = d.queueDepth > 0 ? d.queueDepth + " waiting" : "";
    tick();
  },
  revealdone: () => hideCard(),
  catchup: (d) => {
    catchup.querySelector("h3").textContent = "caught up: picks " + d.from + " through " + d.to;
    const list = catchup.querySelector(".list");
    list.replaceChildren();
    for (const p of d.picks) {
      const row = document.createElement("div");
      const who = document.createElement("span");
      who.textContent = p.teamName + " - ";
      row.append(who, document.createTextNode(p.name));
      list.append(row);
    }
    catchup.classList.add("show");
    clearTimeout(catchupTimer);
    catchupTimer = setTimeout(() => catchup.classList.remove("show"), d.ms || 2500);
  },
  say: (d) => play(d),
  status: (d) => {
    if (d.version) version = d.version;
  },
  onConnection: (s) => down.classList.toggle("show", !s.connected),
});

// Rendered audio when the booth has it, the laptop's own voice when it does not.
// Either way the server is told when the line finished, so it knows the speaker
// is free. It does not depend on that message arriving - it has its own deadline
// - but reporting honestly keeps the channel tight.
let player = null;

function play(d) {
  const finish = () => done(d.id);
  if (d.audioUrl) {
    try {
      player = new Audio(d.audioUrl);
      player.onended = finish;
      player.onerror = () => speak(d.text, finish);
      player.play().catch(() => speak(d.text, finish));
      return;
    } catch {
      // fall through to the system voice
    }
  }
  speak(d.text, finish);
}

function done(id) {
  if (!id) return;
  fetch("/api/audio-done", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  })
    .then(drain)
    .catch(() => {});
}

/** The always-available voice. Real voices layer on top of this, never under it. */
function speak(text, onEnd) {
  if (!text || !window.speechSynthesis) {
    onEnd?.();
    return;
  }
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 0.95;
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    window.speechSynthesis.speak(u);
  } catch {
    onEnd?.();
  }
}

// Chrome will not play audio in a tab that has never been clicked. This is the
// one touch a TV ever gets, and it happens during setup, not during the show.
arm.addEventListener("click", async () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume();
    window.__audio = ctx;
  } catch {}
  arm.classList.add("hidden");
  register("studio", { audioArmed: true });
});

loadYouTube();
register("studio", { audioArmed: false });
heartbeat("studio", () => version, () => buildId);
keepAwake();
