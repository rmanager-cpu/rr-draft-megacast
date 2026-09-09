// The launch gate: one press, and only when everything that can be checked has
// been. A registry rather than a fixed list, so the booth and the highlight
// catalogue can add their own preflight without editing this file. A check that
// nobody registered reports "not applicable" and never blocks - the core has to
// be able to ship on its own.

export function createLaunch({ state, sse, onInfo = () => {} }) {
  const checks = new Map();

  function registerCheck(name, { label, run, blocking = true }) {
    checks.set(name, { name, label, run, blocking });
  }

  async function evaluate() {
    const results = [];
    for (const c of checks.values()) {
      let r;
      try {
        r = (await c.run()) ?? { ok: false, detail: "no result" };
      } catch (e) {
        r = { ok: false, detail: e.message };
      }
      results.push({ name: c.name, label: c.label, blocking: c.blocking, ...r });
    }
    const ready = results.every((r) => r.ok || r.na || !r.blocking);
    state.touch((s) => {
      s.launch.checks = Object.fromEntries(results.map((r) => [r.name, r]));
      s.launch.armed = ready;
    });
    return { ready, checks: results };
  }

  function launch({ force = false } = {}) {
    if (state.state.launch.launchedAt && !force) {
      return { ok: false, reason: "already launched" };
    }
    // Freeze the show config at the press, so an edit mid-draft cannot half-apply.
    state.apply((s) => {
      s.launch.launchedAt = Date.now();
      s.phase = s.phase === "boot" ? "pre" : s.phase === "pre" ? "live" : s.phase;
    });
    onInfo("LAUNCHED at " + new Date().toLocaleTimeString());
    sse.send("launch", { launchedAt: state.state.launch.launchedAt, version: state.version });
    return { ok: true, launchedAt: state.state.launch.launchedAt };
  }

  return { registerCheck, evaluate, launch, get names() { return [...checks.keys()]; } };
}

/** The checks the core owns. Others register their own. */
// getSource rather than source: the wire is created after the checks are, and
// destructuring a getter here would freeze it as null forever.
export function registerCoreChecks(launch, { state, getSource = () => null, players }) {
  const displays = () => state.state.launch.displays ?? {};
  const seen = (d) => d && Date.now() - (d.lastSeen ?? d.at ?? 0) < 8000;

  launch.registerCheck("wire", {
    label: "Draft room readable",
    run: () => {
      const c = state.state.connection;
      const src = getSource();
      if (src?.simulated) return { ok: true, detail: "SIMULATOR - " + (src.name ?? "replay"), simulated: true };
      // Discovering this at five to seven would be the worst possible moment.
      if (c.contested) return { ok: false, detail: "another session is using this ESPN account - the show needs its own" };
      if (c.status !== "connected") return { ok: false, detail: c.detail || c.status };
      const age = Date.now() - (c.lastFrameAt || 0);
      if (age > 60000) return { ok: false, detail: `no frame for ${Math.round(age / 1000)}s` };
      return { ok: true, detail: "connected" + (c.rttMs ? `, ${c.rttMs}ms` : "") };
    },
  });

  launch.registerCheck("league", {
    label: "League and draft order",
    run: () => {
      const d = state.state.draft;
      if (!d.teamCount || !d.rounds) return { ok: false, detail: "waiting for the room snapshot" };
      const order = d.order ?? [];
      const missing = [];
      for (let p = 1; p <= d.teamCount * d.rounds; p++) if (!order[p]) missing.push(p);
      if (missing.length) return { ok: false, detail: missing.length + " pick slots have no team" };
      return { ok: true, detail: `${d.teamCount} teams, ${d.rounds} rounds` };
    },
  });

  launch.registerCheck("players", {
    label: "Player table",
    run: () => {
      if (!players || players.size < 5000) return { ok: false, detail: "table not loaded" };
      const dst = players.all.filter((p) => p.pos === "D/ST").length;
      const k = players.all.filter((p) => p.pos === "K").length;
      if (dst < 30 || k < 25) return { ok: false, detail: `only ${dst} defences and ${k} kickers` };
      return { ok: true, detail: `${players.size} players, ${players.source}` };
    },
  });

  launch.registerCheck("displays", {
    label: "TV on this build, 1080p",
    run: () => {
      // The studio is the show: cards, clips, audio. The board is optional -
      // the owner dropped it on draft night - so it is checked only when open.
      const b = displays().board;
      const s = displays().studio;
      if (!s) return { ok: false, detail: "waiting for the studio" };
      if (!seen(s) || (b && !seen(b))) return { ok: false, detail: "a TV has stopped checking in" };

      // "Same version" has to mean the same server generation, not an exact
      // match on a counter that moves with every pick - two TVs never sample
      // that in the same instant. What this must catch is a tab left open from
      // a previous run, quietly showing yesterday.
      const build = state.buildId;
      const stale = [
        b && b.build !== build ? "board" : null,
        s.build !== build ? "studio" : null,
      ].filter(Boolean);
      if (stale.length) return { ok: false, detail: stale.join(" and ") + " left over from an earlier run - reload" };

      const sizes = [b?.screen, s.screen].filter((x) => x && x !== "1920x1080");
      if (sizes.length) return { ok: false, detail: "not at 1080p: " + sizes.join(", ") };
      return { ok: true, detail: (b ? "both TVs" : "studio") + " live on this build, 1080p" };
    },
  });

  launch.registerCheck("audio", {
    label: "Speaker plays the test line",
    run: () => {
      const s = displays().studio;
      if (!s?.audioArmed) return { ok: false, detail: "click the studio window once to arm audio" };
      if (!state.state.launch.audioConfirmed) return { ok: false, detail: "play the test line and confirm you heard it" };
      return { ok: true, detail: "armed and confirmed" };
    },
  });

  launch.registerCheck("disk", {
    label: "State is being written",
    run: () => {
      state.save();
      return { ok: true, detail: "data/state.json" };
    },
  });
}
