const el = (id) => document.getElementById(id);
let teamsLoaded = false;

function stat(k, v, cls) {
  const d = document.createElement("div");
  d.className = "stat";
  const kk = document.createElement("div");
  kk.className = "k";
  kk.textContent = k;
  const vv = document.createElement("div");
  vv.className = "v" + (cls ? " " + cls : "");
  vv.textContent = v;
  d.append(kk, vv);
  return d;
}

async function poll() {
  let s;
  try {
    s = await fetch("/api/state").then((r) => r.json());
  } catch {
    el("sub").textContent = "the server is not answering";
    return;
  }

  el("title").textContent = s.league.name || "Status";
  el("sim").classList.toggle("show", !!s.simulated);
  const conn = s.connection || {};
  const total = (s.league.teams?.length || 0) * (s.league.rounds || 0);

  el("sub").textContent =
    s.phase + " · " + (s.source || "") + (s.launch.launchedAt ? " · launched " + new Date(s.launch.launchedAt).toLocaleTimeString() : "");

  el("stats").replaceChildren(
    stat("picks", s.picks.length + (total ? " / " + total : "")),
    stat("wire", conn.status || "?", conn.status === "connected" ? "" : "bad"),
    stat("gaps", s.gaps.length, s.gaps.length ? "bad" : ""),
    stat("duplicates", s.counters.duplicates || 0),
    stat("corrections", s.counters.corrections || 0, s.counters.corrections ? "warn" : ""),
    stat("flagged", s.counters.suspects || 0, s.counters.suspects ? "bad" : ""),
    stat("reveal queue", s.reveal ? s.reveal.queueDepth || 0 : 0),
    stat("round trip", conn.rttMs ? conn.rttMs + " ms" : "—"),
  );

  if (!teamsLoaded && s.league.teams?.length) {
    el("team").replaceChildren(
      ...s.league.teams.map((t) => {
        const o = document.createElement("option");
        o.value = t.id;
        o.textContent = t.name;
        return o;
      }),
    );
    teamsLoaded = true;
  }

  el("warnings").replaceChildren(
    ...(s.warnings || []).slice(0, 30).map((w) => {
      const d = document.createElement("div");
      d.textContent = (w.at || "").slice(11, 19) + "  " + w.text;
      return d;
    }),
  );
  if (!(s.warnings || []).length) el("warnings").textContent = "none";
}

el("enter").addEventListener("click", async () => {
  const r = await fetch("/api/pick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teamId: Number(el("team").value), playerName: el("player").value }),
  }).then((x) => x.json());
  if (r.ok) {
    el("pickmsg").className = "note good";
    el("pickmsg").textContent = "entered at pick " + r.pick.pick;
    el("player").value = "";
  } else {
    el("pickmsg").className = "note err";
    el("pickmsg").textContent = r.reason + (r.candidates?.length ? ": " + r.candidates.map((c) => c.name).join(", ") : "");
  }
  poll();
});

el("resync").addEventListener("click", async () => {
  const r = await fetch("/api/resync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((x) => x.json());
  el("resync").textContent = r.ok ? "reconnecting…" : r.reason;
  setTimeout(() => (el("resync").textContent = "Force a reconnect"), 3000);
});

poll();
setInterval(poll, 1500);
