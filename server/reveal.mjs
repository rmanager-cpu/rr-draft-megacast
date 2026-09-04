// TV 2: what gets revealed, for how long, and what happens when picks stack up.
//
// The server owns the queue and the clock. The browser is a renderer that plays
// what it is told and holds until the deadline it was given, so a TV that reloads
// mid-reveal picks the card back up with the correct time remaining.
//
// The rule that matters: a reveal already on screen can only ever be SHORTENED,
// never extended, and never cut below a floor once the card has landed. Every
// pick gets its card. Nothing is dropped.
//
//   queue empty when a reveal starts        full     18s
//   one or two waiting                      short     8s
//   three or more waiting                   card      4s
//
// Clip length is a ceiling, not a target. When picks are waiting the dwell is
// cut first and the highlight goes with it - the card is what must survive.

export const DEFAULT_REVEAL = {
  full: { stingMs: 1200, cardInMs: 700, dwellMs: 15400, outMs: 700 }, // 18.0s
  short: { stingMs: 600, cardInMs: 500, dwellMs: 6400, outMs: 500 },  //  8.0s
  card: { stingMs: 0, cardInMs: 400, dwellMs: 3200, outMs: 400 },     //  4.0s
  minOnScreenMs: 2500,
  shortThreshold: 1,
  cardThreshold: 3,
  catchupMode: "newest", // "newest" | "all"
  catchupStripMs: 2500,
};

const realClock = { now: () => Date.now(), setTimeout, clearTimeout };

export function createReveal({
  config = {},
  clock = realClock,
  onReveal = () => {},
  onCut = () => {},
  onDone = () => {},
  onCatchup = () => {},
} = {}) {
  const cfg = { ...DEFAULT_REVEAL, ...config };
  const queue = [];
  let current = null;
  let timer = null;
  let revealed = 0;
  let contentProvider = null;

  function modeFor(depthAfter) {
    if (depthAfter >= cfg.cardThreshold) return "card";
    if (depthAfter >= cfg.shortThreshold) return "short";
    return "full";
  }

  /** Highlights register here. Budgeted and guarded: the reveal never waits on it. */
  function setContentProvider(fn) {
    contentProvider = fn;
  }

  function content(card) {
    if (!contentProvider) return null;
    try {
      return contentProvider(card) ?? null;
    } catch {
      return null;
    }
  }

  function enqueue(card, { catchup = false } = {}) {
    if (card.isKeeper) return; // keepers belong on the board, not in a reveal
    queue.push({ card, content: content(card), catchup });
    if (!current) next();
  }

  /**
   * A batch of picks learned at once - a reconnect filling in what we missed.
   * Revealing them all would put the studio minutes behind the room, which is
   * worse than not revealing them. Show a strip naming them, then the newest.
   */
  function enqueueCatchup(cards) {
    const real = cards.filter((c) => !c.isKeeper);
    if (!real.length) return;
    if (cfg.catchupMode === "all") {
      for (const c of real) enqueue(c);
      return;
    }
    const newest = real[real.length - 1];
    const covered = real.slice(0, -1);
    if (covered.length) {
      onCatchup({
        picks: covered.map((c) => ({ pick: c.pick, name: c.name, teamName: c.teamName })),
        from: covered[0].pick,
        to: covered[covered.length - 1].pick,
        ms: cfg.catchupStripMs,
      });
    }
    enqueue(newest);
  }

  function next() {
    if (current || !queue.length) return;
    const item = queue.shift();
    const mode = modeFor(queue.length);
    const t = cfg[mode];
    const now = clock.now();
    const cardInDoneAt = now + t.stingMs + t.cardInMs;
    current = {
      ...item,
      mode,
      startedAt: now,
      cardInDoneAt,
      floor: cardInDoneAt + cfg.minOnScreenMs,
      deadline: cardInDoneAt + t.dwellMs,
      timing: t,
    };
    revealed++;
    onReveal({
      pick: item.card.pick,
      card: item.card,
      content: item.content,
      mode,
      phases: t,
      startsAt: now,
      endsAt: current.deadline,
      queueDepth: queue.length,
    });
    arm();
  }

  function arm() {
    clock.clearTimeout(timer);
    const wait = Math.max(0, current.deadline - clock.now()) + current.timing.outMs;
    timer = clock.setTimeout(finish, wait);
  }

  function finish() {
    if (!current) return;
    const done = current;
    current = null;
    onDone({ pick: done.card.pick });
    next();
  }

  /** Picks are waiting: shorten what is on screen, down to the floor, never past it. */
  function compress() {
    if (!current || queue.length < cfg.shortThreshold) return;
    const now = clock.now();
    const target = Math.max(now + 1500, current.floor);
    if (target >= current.deadline) return;
    current.deadline = target;
    onCut({ pick: current.card.pick, endsAt: target, queueDepth: queue.length });
    arm();
  }

  return {
    enqueue(card, opts) {
      enqueue(card, opts);
      compress();
    },
    enqueueCatchup,
    setContentProvider,
    current: () => (current ? { pick: current.card.pick, mode: current.mode, endsAt: current.deadline, card: current.card, content: current.content } : null),
    depth: () => queue.length,
    revealed: () => revealed,
    stop() {
      clock.clearTimeout(timer);
      timer = null;
    },
    config: cfg,
  };
}
