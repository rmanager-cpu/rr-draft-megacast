import { connect, heartbeat, keepAwake, POS_CLASS, register } from "./common.js";

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
const arm = document.getElementById("arm");
const down = document.getElementById("down");

let version = 0;
let skew = 0; // serverTime minus our clock, so a deadline means the same on both sides
let current = null;
let raf = null;
let catchupTimer = null;

const serverNow = () => Date.now() + skew;
const shotUrl = (c) => "/img/headshot/" + c.playerId + (c.proTeam ? "?team=" + encodeURIComponent(c.proTeam) : "");

// Start the image fetch the moment a pick commits, not when its reveal begins.
function preload(playerId, proTeam) {
  const img = new Image();
  img.src = shotUrl({ playerId, proTeam });
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

  tick();
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
  status: (d) => {
    if (d.version) version = d.version;
  },
  onConnection: (s) => down.classList.toggle("show", !s.connected),
});

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

register("studio", { audioArmed: false });
heartbeat("studio", () => version);
keepAwake();
