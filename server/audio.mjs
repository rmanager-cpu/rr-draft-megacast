// One speaker, one channel, one thing talking at a time.
//
// The rules come straight from the show bible:
//   - never overlap, and never interrupt a recap
//   - a pick landing mid-recap still reveals on the TVs, with its call suppressed
//   - interjections are live and therefore perishable: if one is not ready in
//     time it is dropped, never queued, because a reaction to a pick from two
//     minutes ago is worse than silence
//   - visuals never wait on audio, which is why nothing here can call back into
//     the reveal
//
// The channel reports done from the browser that actually played the sound, but
// it never trusts that to arrive. Every item carries a deadline, and a channel
// that would otherwise wedge frees itself. A stuck speaker must not end the show.

export const KIND = {
  OPEN: "OPEN",
  NAME: "NAME",
  INTERJECT: "INTERJECT",
  BIT: "BIT",
  RECAP: "RECAP",
  FINAL: "FINAL",
};

// Higher wins when choosing what to play next. Nothing preempts what is playing.
const RANK = { FINAL: 60, RECAP: 50, OPEN: 50, BIT: 30, INTERJECT: 20, NAME: 10 };

const realClock = { now: () => Date.now(), setTimeout, clearTimeout };

export function createAudio({
  clock = realClock,
  onPlay = () => {},
  onIdle = () => {},
  onDropped = () => {},
  graceMs = 6000, // how long past the estimate before we assume the browser died
  estimateMsPerWord = 380,
} = {}) {
  const queue = [];
  let playing = null;
  let timer = null;
  let seq = 0;
  const counts = { played: 0, dropped: 0, timedOut: 0, suppressed: 0 };

  const estimate = (item) =>
    item.durationMs ?? Math.max(1200, String(item.text ?? "").trim().split(/\s+/).filter(Boolean).length * estimateMsPerWord);

  function enqueue(item) {
    const now = clock.now();
    const entry = {
      id: "a" + ++seq,
      kind: item.kind ?? KIND.NAME,
      text: item.text ?? "",
      audioUrl: item.audioUrl ?? null,
      meta: item.meta ?? {},
      queuedAt: now,
      // Perishable items say when they stop being worth playing.
      expiresAt: item.expiresAt ?? (item.kind === KIND.INTERJECT ? now + 10000 : 0),
      durationMs: item.durationMs,
    };

    // A pick call that lands while the booth is mid-recap is suppressed, not
    // queued. The reveal still happens; the recap covers the pick shortly.
    if (entry.kind === KIND.NAME && isTalking(KIND.RECAP)) {
      counts.suppressed++;
      onDropped({ ...entry, reason: "recap in progress" });
      return { queued: false, reason: "suppressed" };
    }
    if (entry.kind === KIND.INTERJECT && (playing || queue.length)) {
      // Never queue a reaction. Either it goes now or it never happened.
      counts.dropped++;
      onDropped({ ...entry, reason: "channel busy" });
      return { queued: false, reason: "busy" };
    }

    queue.push(entry);
    pump();
    return { queued: true, id: entry.id };
  }

  const isTalking = (kind) => !!playing && playing.kind === kind;

  function pump() {
    if (playing) return;
    const now = clock.now();
    // Drop anything that has gone stale while it waited.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].expiresAt && queue[i].expiresAt < now) {
        counts.dropped++;
        onDropped({ ...queue[i], reason: "too late to matter" });
        queue.splice(i, 1);
      }
    }
    if (!queue.length) {
      onIdle();
      return;
    }
    queue.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.queuedAt - b.queuedAt);
    playing = queue.shift();
    playing.startedAt = now;
    playing.estimateMs = estimate(playing);
    counts.played++;
    onPlay(playing);

    clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      // The browser never said it finished. Assume it did rather than wedging.
      counts.timedOut++;
      done(playing?.id, { timedOut: true });
    }, playing.estimateMs + graceMs);
  }

  /** The browser that played it says so. */
  function done(id, { timedOut = false } = {}) {
    if (!playing || (id && playing.id !== id)) return false;
    clock.clearTimeout(timer);
    timer = null;
    playing = null;
    if (!timedOut) counts.played += 0;
    pump();
    return true;
  }

  return {
    enqueue,
    done,
    KIND,
    /** True while a recap is on the speaker: the caller suppresses stings. */
    get talkingOver() {
      return isTalking(KIND.RECAP) || isTalking(KIND.FINAL) || isTalking(KIND.OPEN);
    },
    get current() {
      return playing;
    },
    get depth() {
      return queue.length;
    },
    counts: () => ({ ...counts, queued: queue.length, playing: playing?.kind ?? null }),
    stop() {
      clock.clearTimeout(timer);
      queue.length = 0;
      playing = null;
    },
  };
}
