const el = (id) => document.getElementById(id);
let rows = [];
let current = null;

const seconds = (s) => {
  const t = String(s ?? "").trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(\d+):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

async function load() {
  const data = await fetch("/api/catalog?limit=200").then((r) => r.json());
  rows = data.rows;
  el("sub").textContent =
    data.withClips + " of the top " + rows.length + " have a clip. Everyone else gets the animated card, which is the design.";
  el("list").replaceChildren(
    ...rows.map((p, i) => {
      const d = document.createElement("div");
      d.className = "p" + (current === i ? " on" : "");
      const adp = document.createElement("span");
      adp.className = "adp";
      adp.textContent = p.adp ?? "";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name;
      const pos = document.createElement("span");
      pos.className = "pos";
      pos.textContent = p.pos + " " + p.proTeam;
      const has = document.createElement("span");
      has.className = "has";
      has.textContent = p.local ? "●" : p.clip?.videoId ? (p.clip.verifiedAt ? "✓" : "•") : "";
      if (p.local) has.title = "local video on disk";
      d.append(adp, nm, pos, has);
      d.addEventListener("click", () => select(i));
      return d;
    }),
  );
}

function select(i) {
  current = i;
  const p = rows[i];
  el("who").textContent = p.name + "  —  " + p.pos + " " + p.proTeam + (p.adp ? "  ·  ADP " + p.adp : "");
  el("url").value = p.clip?.videoId ? "https://www.youtube.com/watch?v=" + p.clip.videoId : "";
  el("start").value = p.clip?.start ?? "";
  el("ceiling").value = p.clip ? Math.round((p.clip.ceilingMs ?? 8000) / 1000) : 8;
  el("msg").textContent = "";
  preview();
  load();
}

function preview() {
  const url = el("url").value.trim();
  const id = url.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] || url.match(/([A-Za-z0-9_-]{11})$/)?.[1];
  if (!id) {
    el("frame").removeAttribute("src");
    return;
  }
  const s = seconds(el("start").value);
  el("frame").src = "https://www.youtube.com/embed/" + id + "?start=" + s + "&autoplay=1&mute=1&controls=1&rel=0";
}

el("test").addEventListener("click", preview);

// The file goes to the server as raw bytes: no form encoding, no library, and
// nothing large held in memory at either end.
el("upload").addEventListener("click", async () => {
  if (current === null) return;
  const f = el("file").files[0];
  if (!f) {
    el("msg").className = "note err";
    el("msg").textContent = "choose a video file first";
    return;
  }
  el("msg").className = "note";
  el("msg").textContent = "saving " + Math.round(f.size / 1048576) + " MB...";
  const r = await fetch("/api/clip/" + rows[current].playerId, {
    method: "POST",
    headers: { "x-filename": f.name, "content-type": "application/octet-stream" },
    body: f,
  })
    .then((x) => x.json())
    .catch((e) => ({ ok: false, reason: String(e) }));
  if (r.ok) {
    await fetch("/api/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: rows[current].playerId,
        localOnly: true,
        url: el("url").value,
        start: seconds(el("start").value),
        ceilingMs: Math.max(2, Number(el("ceiling").value) || 8) * 1000,
        title: rows[current].name,
      }),
    });
  }
  el("msg").className = r.ok ? "note good" : "note err";
  el("msg").textContent = r.ok ? "saved " + Math.round(r.bytes / 1048576) + " MB to disk" : r.reason;
  load();
});

el("save").addEventListener("click", async () => {
  if (current === null) return;
  const r = await fetch("/api/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId: rows[current].playerId,
      url: el("url").value,
      start: seconds(el("start").value),
      ceilingMs: Math.max(2, Number(el("ceiling").value) || 8) * 1000,
      title: rows[current].name,
    }),
  }).then((x) => x.json());
  el("msg").className = r.ok ? "note good" : "note err";
  el("msg").textContent = r.ok ? "saved" : r.reason;
  load();
});

el("clear").addEventListener("click", async () => {
  if (current === null) return;
  await fetch("/api/catalog/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId: rows[current].playerId }),
  });
  el("url").value = "";
  el("msg").textContent = "removed";
  load();
});

el("pre").addEventListener("click", async () => {
  el("premsg").textContent = "checking…";
  const r = await fetch("/api/catalog/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(
    (x) => x.json(),
  );
  el("premsg").textContent = r.bad.length
    ? r.bad.length + " of " + r.total + " will not embed: " + r.bad.map((b) => b.videoId).join(", ")
    : r.total + " clips all good";
  load();
});

load();
