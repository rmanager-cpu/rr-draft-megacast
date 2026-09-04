// The single description of what is on screen right now.
//
// Two counters, each with one job. `version` is the CONTENT version: it moves
// only when something a viewer would notice changes - a pick, a correction, the
// phase, the launch. It is what /launch compares across the two TVs to prove
// they are showing the same show. `seq` is the STREAM counter: it moves on every
// message sent and is what a reconnecting browser replays from. Keeping them
// apart means a clock tick every five seconds does not churn the number the
// launch gate is watching.

import { writeAtomicSync, readJsonSync, createJournal } from "./persist.mjs";

export function createState({ season, leagueId, bus, stateFile = "data/state.json", journalFile = "data/picks.jsonl", onWarn = () => {} }) {
  const journal = createJournal(journalFile, { onWarn });
  let version = 0;
  let seq = 0;
  let saveTimer = null;

  // Unique to this process. A TV left open from a previous run reports the old
  // one, which is exactly the failure the launch gate has to catch.
  const buildId = String(Date.now().toString(36));

  const s = {
    buildId,
    season,
    leagueId,
    leagueName: "",
    startedAt: new Date().toISOString(),
    source: "",
    simulated: false,
    phase: "boot", // boot -> pre -> live -> complete
    connection: { status: "down", since: Date.now(), attempts: 0, lastFrameAt: 0, rttMs: 0, detail: "" },
    draft: { teamCount: 0, rounds: 0, secondsPerPick: 0, keeperCount: 0, teams: [], order: [] },
    onClock: null,
    picks: [],
    gaps: [],
    counters: { committed: 0, duplicates: 0, corrections: 0, suspects: 0, gapsOpened: 0 },
    reveal: { current: null, queueDepth: 0, revealed: 0 },
    launch: { armed: false, launchedAt: 0, checks: {}, displays: {} },
    warnings: [],
  };

  /** Change content. The version moves, the state is persisted, listeners hear it. */
  function apply(mutator, { persist = true } = {}) {
    mutator(s);
    version++;
    bus?.emit("state", { version });
    if (persist) scheduleSave();
    return version;
  }

  /** Change something transient - a clock tick, a connection blip. No version bump. */
  function touch(mutator) {
    mutator(s);
  }

  function scheduleSave(immediate = false) {
    if (immediate) {
      clearTimeout(saveTimer);
      saveTimer = null;
      save();
      return;
    }
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 2000);
  }

  function save() {
    writeAtomicSync(stateFile, { savedAt: new Date().toISOString(), version, state: s }, { onWarn });
  }

  /** Pull the board out of the reconciler and publish it. */
  function adoptReconciler(rec) {
    const snap = rec.snapshot();
    apply((st) => {
      st.picks = snap.picks;
      st.gaps = snap.gaps;
      st.counters = snap.counters;
      st.draft.order = snap.order;
      st.draft.teamCount = snap.teamCount;
      st.draft.rounds = snap.rounds;
      if (snap.complete && st.phase === "live") st.phase = "complete";
    });
    return snap;
  }

  function recordPicks(list) {
    for (const p of list) journal.append(p);
    scheduleSave(true);
  }

  function warn(text) {
    const entry = { at: new Date().toISOString(), text };
    touch((st) => {
      st.warnings.unshift(entry);
      if (st.warnings.length > 50) st.warnings.length = 50;
    });
    bus?.emit("warning", entry);
  }

  function restore() {
    const saved = readJsonSync(stateFile);
    if (!saved?.state) return null;
    if (saved.state.season !== season || saved.state.leagueId !== leagueId) return null;
    const ageHours = (Date.now() - Date.parse(saved.savedAt ?? 0)) / 3600000;
    if (!(ageHours < 12)) return null;
    return saved.state;
  }

  return {
    buildId,
    get state() {
      return s;
    },
    get version() {
      return version;
    },
    nextSeq() {
      return ++seq;
    },
    get seq() {
      return seq;
    },
    apply,
    touch,
    warn,
    adoptReconciler,
    recordPicks,
    restore,
    save: () => scheduleSave(true),
    journal,
  };
}
