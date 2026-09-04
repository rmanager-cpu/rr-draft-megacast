// Turns a stream of wire frames into a board that is never wrong.
//
// The wire tells us WHO picked WHOM. It never says which pick number that was.
// The draft order supplies the number, and the order comes from the room's own
// INIT snapshot (authoritative, includes keepers and any custom order), falling
// back to the league's pickOrder setting, falling back to team id order.
//
// Three things can go wrong and all three are handled here:
//   duplicates  - a reconnect replays frames we already have. Dedupe by player:
//                 a player is drafted exactly once, which is stronger than any
//                 frame-text comparison.
//   gaps        - we were disconnected while picks happened. Detected because a
//                 pick arrives for a team that is not on the clock. We record the
//                 skipped slots as gaps and ask for a resync; the next INIT fills
//                 them in with exact pick numbers.
//   corrections - INIT disagrees with something we committed. INIT wins, and we
//                 emit a correction so the board patches that one cell.

export function pickKey(season, leagueId, pick) {
  return `${season}:${leagueId}:${pick}`;
}

/** Expand a round-one team order into a full snake, as pick -> teamId. */
export function snakeOrder(pickOrder, rounds) {
  const teams = pickOrder.length;
  const order = new Int32Array(teams * rounds + 1);
  for (let r = 0; r < rounds; r++) {
    const row = r % 2 === 0 ? pickOrder : [...pickOrder].reverse();
    for (let i = 0; i < teams; i++) order[r * teams + i + 1] = row[i];
  }
  return order;
}

const noop = () => {};

export function createReconciler({
  season,
  leagueId,
  teamCount,
  rounds,
  order,
  clock = Date.now,
  onPick = noop,
  onCorrection = noop,
  onGap = noop,
  onWarn = noop,
  onResyncNeeded = noop,
}) {
  const total = teamCount * rounds;
  let ORDER = order ? Int32Array.from(order) : new Int32Array(total + 1);
  let orderSource = order ? "settings" : "none";

  const picks = new Array(total + 1).fill(null);
  const byPlayer = new Map();
  const gaps = new Set();
  const counters = { committed: 0, duplicates: 0, corrections: 0, suspects: 0, gapsOpened: 0 };
  let cursor = 1;

  const roundOf = (pick) => Math.ceil(pick / teamCount);
  const slotInRound = (pick) => pick - (roundOf(pick) - 1) * teamCount;

  // The cursor is the next pick we expect to see on the wire. It steps over
  // picks we already have AND over slots we have already written off as missed -
  // a known gap must not block the live draft behind it, or every later pick
  // gets shoved into the hole.
  function advanceCursor() {
    while (cursor <= total && (picks[cursor] || gaps.has(cursor))) cursor++;
  }

  function commit(pick, { teamId, playerId, slot, source, suspect }) {
    const entry = {
      pick,
      round: roundOf(pick),
      slotInRound: slotInRound(pick),
      key: pickKey(season, leagueId, pick),
      teamId,
      playerId,
      slot: slot ?? 0,
      at: clock(),
      source,
      ...(suspect ? { suspect: true } : {}),
    };
    picks[pick] = entry;
    byPlayer.set(playerId, pick);
    gaps.delete(pick);
    counters.committed++;
    if (suspect) counters.suspects++;
    advanceCursor();
    return entry;
  }

  /** Learn the room snapshot. Idempotent: the normal reconnect case changes nothing. */
  function adoptInit(records, { phase = "live" } = {}) {
    if (!Array.isArray(records) || !records.length) return { learned: [], corrections: [] };

    // The order in INIT is authoritative. Say so out loud if it contradicts settings.
    if (records.length === total) {
      const fromInit = new Int32Array(total + 1);
      for (const r of records) fromInit[r.pick] = r.teamId;
      if (orderSource !== "none") {
        for (let p = 1; p <= total; p++) {
          if (ORDER[p] && ORDER[p] !== fromInit[p]) {
            onWarn(
              `draft order from ${orderSource} disagrees with the room at pick ${p} ` +
                `(${orderSource} says team ${ORDER[p]}, room says team ${fromInit[p]}). Using the room.`,
            );
            break;
          }
        }
      }
      ORDER = fromInit;
      orderSource = "init";
    }

    const learned = [];
    const corrections = [];
    for (const r of records) {
      if (r.playerId === null || r.playerId === undefined) continue;
      const existing = picks[r.pick];
      if (existing && existing.playerId === r.playerId) continue;
      if (existing) {
        byPlayer.delete(existing.playerId);
        picks[r.pick] = null;
        counters.committed--;
        counters.corrections++;
        const now = commit(r.pick, {
          teamId: r.teamId,
          playerId: r.playerId,
          slot: r.slot,
          source: "init",
        });
        corrections.push({ pick: r.pick, was: existing.playerId, now: r.playerId });
        onCorrection({ pick: r.pick, was: existing, now });
        continue;
      }
      // A player we already have at a different pick number: that earlier commit
      // was placed by inference and INIT knows better. Move it.
      const held = byPlayer.get(r.playerId);
      if (held !== undefined && held !== r.pick) {
        byPlayer.delete(r.playerId);
        picks[held] = null;
        counters.committed--;
        gaps.add(held);
        counters.corrections++;
      }
      learned.push(
        commit(r.pick, {
          teamId: r.teamId,
          playerId: r.playerId,
          slot: r.slot,
          source: phase === "pre" ? "keeper" : "init",
        }),
      );
    }

    // Anything still empty below the highest known pick is a gap, not a mystery.
    recomputeGaps();
    if (learned.length) onPick(learned, { catchup: learned.length > 1 });
    return { learned, corrections };
  }

  function recomputeGaps() {
    let highest = 0;
    for (let p = total; p >= 1; p--) {
      if (picks[p]) {
        highest = p;
        break;
      }
    }
    gaps.clear();
    for (let p = 1; p < highest; p++) if (!picks[p]) gaps.add(p);
    cursor = 1;
    advanceCursor();
  }

  /** A pick off the wire. Returns the committed entry, or null if it was ignored. */
  function onSelected({ teamId, playerId, slot }) {
    if (!Number.isFinite(playerId) || !Number.isFinite(teamId)) return null;

    // A player is drafted once. This catches replayed frames on reconnect overlap.
    if (byPlayer.has(playerId)) {
      counters.duplicates++;
      return null;
    }
    advanceCursor();
    if (cursor > total) {
      onWarn(`pick arrived after the board was full (team ${teamId}, player ${playerId})`);
      return null;
    }

    // The expected case: whoever is on the clock just picked.
    if (ORDER[cursor] === teamId || !ORDER[cursor]) {
      const entry = commit(cursor, { teamId, playerId, slot, source: "wire" });
      onPick([entry], { catchup: false });
      return entry;
    }

    // Out of turn almost always means we missed frames, not that ESPN reordered.
    // Look ahead one full snake turn plus slack for this team's next open slot.
    const limit = Math.min(total, cursor + 2 * teamCount);
    for (let p = cursor; p <= limit; p++) {
      if (picks[p] || ORDER[p] !== teamId) continue;
      const skipped = [];
      for (let q = cursor; q < p; q++) {
        if (!picks[q]) {
          gaps.add(q);
          skipped.push(q);
        }
      }
      if (skipped.length) {
        counters.gapsOpened += skipped.length;
        onGap(skipped);
        onResyncNeeded(`missed ${skipped.length} pick(s) before pick ${p}`);
      }
      const entry = commit(p, { teamId, playerId, slot, source: "wire" });
      onPick([entry], { catchup: false });
      return entry;
    }

    // Nothing fits. Commit where we are, flag it, and demand a resync. INIT will
    // correct it within seconds and the board will patch that cell.
    const entry = commit(cursor, { teamId, playerId, slot, source: "wire", suspect: true });
    onWarn(`pick from team ${teamId} does not fit the draft order near pick ${entry.pick}; flagged for resync`);
    onResyncNeeded("pick did not fit the draft order");
    onPick([entry], { catchup: false });
    return entry;
  }

  /** The emergency field on /status. Identical downstream except for its source. */
  function manualPick({ teamId, playerId }) {
    if (byPlayer.has(playerId)) return { ok: false, reason: "that player is already drafted" };
    advanceCursor();
    if (cursor > total) return { ok: false, reason: "the board is full" };
    const pick = ORDER[cursor] === teamId ? cursor : findNextSlotFor(teamId);
    if (!pick) return { ok: false, reason: "no open pick for that team" };
    const entry = commit(pick, { teamId, playerId, slot: 0, source: "manual" });
    onPick([entry], { catchup: false });
    return { ok: true, pick: entry };
  }

  function findNextSlotFor(teamId) {
    for (let p = cursor; p <= total; p++) if (!picks[p] && ORDER[p] === teamId) return p;
    return 0;
  }

  function snapshot() {
    return {
      season,
      leagueId,
      teamCount,
      rounds,
      total,
      orderSource,
      order: Array.from(ORDER),
      picks: picks.filter(Boolean),
      gaps: [...gaps].sort((a, b) => a - b),
      cursor,
      counters: { ...counters },
      complete: counters.committed === total,
    };
  }

  function restore(snap) {
    if (!snap || snap.season !== season || snap.leagueId !== leagueId) return false;
    ORDER = Int32Array.from(snap.order ?? []);
    orderSource = snap.orderSource ?? orderSource;
    picks.fill(null);
    byPlayer.clear();
    for (const p of snap.picks ?? []) {
      picks[p.pick] = p;
      byPlayer.set(p.playerId, p.pick);
    }
    Object.assign(counters, snap.counters ?? {});
    counters.committed = (snap.picks ?? []).length;
    recomputeGaps();
    return true;
  }

  return {
    adoptInit,
    onSelected,
    manualPick,
    snapshot,
    restore,
    get cursor() {
      return cursor;
    },
    get total() {
      return total;
    },
    get onClockTeam() {
      return ORDER[cursor] || 0;
    },
    get complete() {
      return counters.committed === total;
    },
  };
}
