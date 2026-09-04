const el = (id) => document.getElementById(id);
let lastChecks = [];

async function poll() {
  try {
    const [gate, state] = await Promise.all([
      fetch("/api/checks").then((r) => r.json()),
      fetch("/api/state").then((r) => r.json()),
    ]);
    render(gate, state);
  } catch {
    el("why").textContent = "the server is not answering";
  }
}

function render(gate, state) {
  lastChecks = gate.checks;
  el("sim").classList.toggle("show", !!state.simulated);

  el("checks").replaceChildren(
    ...gate.checks.map((c) => {
      const row = document.createElement("div");
      row.className = "check" + (c.ok ? " ok" : c.na ? " na" : "");
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = c.label;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = c.na ? "not applicable" : c.detail || "";
      row.append(dot, label, detail);
      return row;
    }),
  );

  const blocking = gate.checks.filter((c) => !c.ok && !c.na && c.blocking);
  el("go").disabled = blocking.length > 0 || !!state.launch.launchedAt;
  el("why").textContent = blocking.length
    ? "waiting on: " + blocking.map((c) => c.label.toLowerCase()).join(", ")
    : state.launch.launchedAt
      ? ""
      : "all clear";
  el("launched").textContent = state.launch.launchedAt
    ? "launched at " + new Date(state.launch.launchedAt).toLocaleTimeString()
    : "";

  const d = state.launch.displays || {};
  el("displays").replaceChildren(
    ...["board", "studio"].map((name) => {
      const tr = document.createElement("tr");
      const info = d[name];
      const cells = [
        name,
        info ? info.screen : "not open",
        info ? (info.fullscreen ? "full screen" : "windowed") : "",
        info && info.acked !== undefined ? "v" + info.acked : "",
        info && info.lastSeen ? Math.round((Date.now() - info.lastSeen) / 1000) + "s ago" : "",
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i) td.className = "dimc";
        td.textContent = text;
        tr.append(td);
      });
      return tr;
    }),
  );
}

el("go").addEventListener("click", async () => {
  el("go").disabled = true;
  const r = await fetch("/api/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).then((x) => x.json());
  if (!r.ok) el("why").textContent = r.reason || "launch refused";
  poll();
});

el("test").addEventListener("click", async () => {
  await fetch("/api/audio-test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  el("audionote").textContent = "sent to the studio window";
});

el("heard").addEventListener("click", async () => {
  await fetch("/api/audio-confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ heard: true }),
  });
  el("audionote").textContent = "confirmed";
  poll();
});

poll();
setInterval(poll, 2000);
