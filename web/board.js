import { connect, heartbeat, keepAwake, POS_CLASS, register } from "./common.js";

const grid = document.getElementById("grid");
const veil = document.getElementById("veil");
const bar = document.getElementById("bar");
const title = document.getElementById("title");
const meta = document.getElementById("meta");
const clock = document.getElementById("clock");

let teams = [];
let rounds = 16;
let order = [];
const cells = new Map(); // overall pick number -> element
let version = 0;
let wireDownSince = 0;

/** Build the whole grid once, then only ever patch single cells. */
function build(hello) {
  teams = hello.league.teams || [];
  rounds = hello.league.rounds || 16;
  order = hello.order || [];
  title.textContent = hello.league.name || "River Ranch Draft";
  meta.textContent = teams.length + " teams  ·  " + rounds + " rounds";

  grid.style.gridTemplateColumns = "repeat(" + teams.length + ", minmax(0, 1fr))";
  grid.style.gridTemplateRows = "auto repeat(" + rounds + ", minmax(0, 1fr))";
  grid.replaceChildren();
  cells.clear();

  for (const t of teams) {
    const h = document.createElement("div");
    h.className = "hcell";
    h.innerHTML = '<div class="team"></div><div class="mgr"></div>';
    h.querySelector(".team").textContent = t.name || "Team " + t.id;
    h.querySelector(".mgr").textContent = t.manager || "";
    grid.append(h);
  }

  // Row = round, column = the team that owns that slot. A snake means column
  // position is not team position, so every cell is placed by draft order.
  for (let round = 1; round <= rounds; round++) {
    const row = [];
    for (let i = 1; i <= teams.length; i++) {
      const pick = (round - 1) * teams.length + i;
      row.push({ pick, teamId: order[pick] });
    }
    // Draw left to right by team, not by pick, so a team owns one column.
    for (const t of teams) {
      const slot = row.find((r) => r.teamId === t.id) || row[0];
      const el = document.createElement("div");
      el.className = "cell empty";
      el.innerHTML =
        '<span class="no"></span><span class="first"></span><span class="last"></span><span class="tag"></span>';
      el.querySelector(".no").textContent = round + "." + String(((slot.pick - 1) % teams.length) + 1).padStart(2, "0");
      grid.append(el);
      cells.set(slot.pick, el);
    }
  }
  for (const p of hello.picks || []) paint(p, { quiet: true });
  for (const g of hello.gaps || []) markGap(g);
  if (hello.onClock) showClock(hello.onClock.teamId, hello.onClock.msLeft);
  if (hello.phase !== "pre" && hello.phase !== "boot") veil.classList.add("hidden");
}

function paint(card, { quiet = false } = {}) {
  const el = cells.get(card.pick);
  if (!el) return;
  el.className = "cell " + POS_CLASS(card.pos) + (card.isKeeper ? " keeper" : "") + (quiet ? "" : " just");
  el.querySelector(".first").textContent = card.firstName || "";
  const lastEl = el.querySelector(".last");
  lastEl.textContent = card.lastName || card.name;
  if (card.suffix) {
    const sfx = document.createElement("span");
    sfx.className = "sfx";
    sfx.textContent = " " + card.suffix;
    lastEl.append(sfx);
  }
  const tag = el.querySelector(".tag");
  tag.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = card.pos;
  tag.append(b, document.createTextNode(" " + (card.proTeam || "")));
  if (!quiet) el.addEventListener("animationend", () => el.classList.remove("just"), { once: true });
}

function markGap(pick) {
  const el = cells.get(pick);
  if (!el || !el.classList.contains("empty")) return;
  el.className = "cell gap";
  el.querySelector(".last").textContent = "recovering";
}

function showClock(teamId, msLeft) {
  const t = teams.find((x) => x.id === teamId);
  clock.innerHTML = "";
  const who = document.createElement("span");
  who.className = "team";
  who.textContent = t ? "on the clock: " + (t.name || "Team " + t.id) : "";
  const secs = document.createElement("span");
  secs.textContent = msLeft > 0 ? Math.ceil(msLeft / 1000) + "s" : "";
  clock.append(who, secs);

  for (const el of cells.values()) el.classList.remove("onclock");
  for (const [pick, el] of cells) {
    if (order[pick] !== teamId || !el.classList.contains("empty")) continue;
    el.classList.add("onclock");
    el.querySelector(".last").textContent = "on the clock";
    break;
  }
}

function banner(kind, text) {
  bar.className = "bar" + (kind ? " " + kind : "");
  bar.textContent = text || "";
}

const state = connect("board", {
  hello: (d) => {
    version = d.version;
    build(d);
    banner("", "");
  },
  pick: (d) => {
    version = d.version;
    const el = cells.get(d.pick);
    if (el) el.classList.remove("onclock");
    paint(d);
  },
  correction: (d) => {
    version = d.version;
    paint(d.now);
  },
  gap: (d) => {
    version = d.version;
    (d.picks || []).forEach(markGap);
  },
  onclock: (d) => {
    version = d.version;
    showClock(d.teamId, 0);
  },
  clock: (d) => showClock(d.teamId, d.msLeft),
  launch: () => veil.classList.add("hidden"),
  status: (d) => {
    if (d.version) version = d.version;
    if (!d.connection) return;
    if (d.connection.status === "connected") {
      wireDownSince = 0;
      banner("", "");
    } else {
      wireDownSince = wireDownSince || Date.now();
    }
  },
  // A dropped stream never clears the board. It says so and keeps what it has.
  onConnection: (s) => {
    if (!s.connected) banner("down", "Lost the server — retrying. The board below is the last thing we knew.");
    else banner("", "");
  },
});

setInterval(() => {
  if (!wireDownSince) return;
  const secs = Math.round((Date.now() - wireDownSince) / 1000);
  const m = Math.floor(secs / 60);
  banner("warn", "ESPN link down " + m + ":" + String(secs % 60).padStart(2, "0") + " — picks will fill in when it returns.");
}, 1000);

register("board");
heartbeat("board", () => version);
keepAwake();
