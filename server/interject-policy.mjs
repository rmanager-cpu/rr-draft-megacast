// Whether a pick is worth reacting to out loud, and whether we are allowed to.
//
// Kept separate from the wiring because getting this wrong is not a crash, it is
// a booth that talks over every single pick for two hours, which nobody would
// enjoy and which no test would otherwise catch.

export function createInterjectPolicy({ config = {}, clock = () => Date.now() } = {}) {
  const maxPerRound = config.maxPerRound ?? 2;
  const cooldownMs = (config.cooldownSeconds ?? 90) * 1000;
  const used = new Map();
  // Negative infinity rather than zero: zero is a real time, and encoding
  // "never" as a falsy number quietly disables the cooldown on any clock that
  // starts there.
  let lastAt = -Infinity;

  /** @returns {{go:boolean, reason:string}} */
  function decide(card, context = {}, { talkingOver = false } = {}) {
    if (talkingOver) return { go: false, reason: "the booth is mid-recap" };

    const count = used.get(card.round) ?? 0;
    if (count >= maxPerRound) return { go: false, reason: "already reacted twice this round" };

    if (clock() - lastAt < cooldownMs) return { go: false, reason: "still inside the cooldown" };

    const gap = card.adp ? card.adp - card.pick : 0;
    const isValue = gap >= 12;
    const isReach = gap <= -14;
    const isRun = (context.runLength ?? 0) >= 3;
    const isEarlySpecialist = (card.pos === "K" || card.pos === "D/ST") && card.round <= 12;
    if (!isValue && !isReach && !isRun && !isEarlySpecialist) {
      return { go: false, reason: "nothing happened worth saying" };
    }

    return {
      go: true,
      reason: isValue ? "value" : isReach ? "reach" : isRun ? "run" : "early " + card.pos,
    };
  }

  /** Called only once a reaction actually goes out. */
  function spent(card) {
    used.set(card.round, (used.get(card.round) ?? 0) + 1);
    lastAt = clock();
  }

  return { decide, spent, counts: () => Object.fromEntries(used) };
}
