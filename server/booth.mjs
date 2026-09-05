// The booth: what gets said, when, and what gets said instead when the writer
// is slow or absent.
//
// Every line has a written fallback that needs no model, no network and no key.
// The show is built so that losing the booth costs colour, never continuity: the
// board still updates, the reveal still runs, and the speaker still calls picks.

import { checkLine, factsFrom, pickPacket } from "./booth-checks.mjs";
import { KIND } from "./audio.mjs";

const POSITION_WORD = { QB: "quarterback", RB: "running back", WR: "wide receiver", TE: "tight end", K: "kicker", "D/ST": "defense" };

/** How interesting a pick is, for choosing what a recap talks about. */
export function interestOf(card, context = {}) {
  let score = 0;
  const reasons = [];
  if (card.adp) {
    const gap = card.adp - card.pick;
    if (gap >= 12) {
      score += Math.min(40, gap);
      reasons.push("value");
    } else if (gap <= -14) {
      score += Math.min(35, -gap * 0.8);
      reasons.push("reach");
    }
  }
  if (context.runLength >= 3) {
    score += 12 + context.runLength * 2;
    reasons.push("run");
  }
  if ((card.pos === "K" || card.pos === "D/ST") && card.round <= 12) {
    score += 30;
    reasons.push("early " + card.pos);
  }
  if (context.firstOfPosition) {
    score += 10;
    reasons.push("first " + card.pos);
  }
  return { score, reasons };
}

/** The deterministic call. No model, no network, always available. */
export function pickCall(card, { style = "sting+name" } = {}) {
  if (style === "sting") return "";
  const pos = POSITION_WORD[card.pos] ?? card.pos;
  if (card.pos === "D/ST") return `${card.teamName} takes the ${card.lastName} defense.`;
  if (style === "call") {
    return `With pick ${card.pick}, ${card.teamName} takes ${card.name}, ${pos}, ${card.proTeam}.`;
  }
  return `${card.name}, ${pos}.`;
}

/** The written recap, used whenever the writer cannot be trusted or reached. */
export function writtenRecap(picks, { round, interesting = [] } = {}) {
  if (!picks.length) return "";
  const parts = [];
  parts.push(round ? `That is round ${round}.` : "That is the draft.");
  for (const p of interesting.slice(0, 3)) {
    const why = p.reasons.includes("value")
      ? `${p.card.name} was still there at ${p.card.pick}`
      : p.reasons.includes("reach")
        ? `${p.card.teamName} went early on ${p.card.name}`
        : p.reasons.includes("run")
          ? `the ${p.card.pos} run kept going through ${p.card.name}`
          : `${p.card.teamName} took ${p.card.name}`;
    parts.push(why + ".");
  }
  const rest = picks.filter((p) => !interesting.some((i) => i.card.pick === p.pick));
  if (rest.length) {
    parts.push("Also off the board: " + rest.map((p) => p.name).join(", ") + ".");
  }
  return parts.join(" ");
}

export function createBooth({
  audio,
  writer = null,
  voice = null,
  config = {},
  getLeague = () => ({ teams: [] }),
  onSay = () => {},
  onWarn = () => {},
  onInfo = () => {},
  notesFor = () => "",
  // Everything the owner wrote about this league. Whatever is in it may be
  // said; whatever is not stays refused. The file is the boundary.
  lore = "",
}) {
  const pickAudio = config.pickAudio ?? "sting+name";
  const loreFacts = factsFrom(lore);
  const stats = { calls: 0, written: 0, generated: 0, rejected: 0, recaps: 0 };

  /** Put a line on the speaker, with sound if we have it and the system voice if not. */
  async function say(kind, text, { voice: which = "play", meta = {}, expiresAt } = {}) {
    if (!text) return null;
    let audioUrl = null;
    if (voice?.available) {
      const rendered = await voice.render(text, { voice: which });
      audioUrl = rendered?.url ?? null;
    }
    const res = audio.enqueue({ kind, text, audioUrl, meta, expiresAt });
    if (res.queued) onSay({ kind, text, audioUrl, meta });
    return res;
  }

  /** A pick landed. Call it, unless the booth is mid-recap. */
  async function callPick(card) {
    stats.calls++;
    const text = pickCall(card, { style: pickAudio });
    if (!text) return { queued: false, reason: "sting only" };
    return say(KIND.NAME, text, { meta: { pick: card.pick } });
  }

  /**
   * A reaction, generated live. Perishable by design: if it is not ready inside
   * the window it is thrown away rather than said about a pick nobody is looking
   * at any more.
   */
  async function interject(card, context) {
    const cfg = config.interjections ?? {};
    const windowMs = (cfg.dropIfLaterThanSeconds ?? 10) * 1000;
    const deadline = Date.now() + windowMs;
    const packet = pickPacket({ card, league: getLeague(), note: notesFor(card.playerId) });
    packet.names = [...packet.names, ...loreFacts.names];
    packet.numbers = [...packet.numbers, ...loreFacts.numbers];
    const { score, reasons } = interestOf(card, context);
    packet.why = reasons;

    if (!writer?.available) return { queued: false, reason: "no writer" };
    const text = await writer.line({ packet, timeoutMs: windowMs });
    if (!text) return { queued: false, reason: "writer late or empty" };

    const verdict = checkLine(text, packet);
    if (!verdict.ok) {
      stats.rejected++;
      onWarn("booth line rejected: " + verdict.problems.join("; "));
      return { queued: false, reason: "failed checks" };
    }
    if (Date.now() > deadline) return { queued: false, reason: "too late" };
    stats.generated++;
    return say(KIND.INTERJECT, text, { meta: { pick: card.pick, score }, expiresAt: deadline });
  }

  /** The round recap. Never interrupted, so it is worth waiting for. */
  async function recap({ picks, round, isFinal = false, seconds }) {
    stats.recaps++;
    const ranked = picks
      .map((card) => ({ card, ...interestOf(card, {}) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.opinionsPerRecap ?? (round <= 2 ? 4 : 7));

    const fallback = writtenRecap(picks, { round, interesting: ranked });

    let text = fallback;
    if (writer?.available) {
      const packet = {
        kind: isFinal ? "final" : "recap",
        round,
        seconds: seconds ?? (round <= 2 ? 70 : 100),
        picks: picks.map((c) => ({
          pick: c.pick,
          player: c.name,
          position: c.pos,
          proTeam: c.proTeam,
          team: c.teamName,
          manager: c.manager,
          adp: c.adp ?? null,
        })),
        interesting: ranked.map((r) => ({ pick: r.card.pick, player: r.card.name, why: r.reasons })),
        names: [
          ...picks.flatMap((c) => [c.name, c.teamName, c.manager, c.proTeam]),
          ...(getLeague().teams ?? []).flatMap((t) => [t.name, t.manager]),
          ...loreFacts.names,
        ].filter(Boolean),
        numbers: [round, ...picks.map((c) => c.pick), ...picks.map((c) => c.adp).filter(Boolean), ...loreFacts.numbers],
        notes: picks.map((c) => notesFor(c.playerId)).filter(Boolean).join(" "),
        maxChars: 1400,
      };
      const drafted = await writer.recap({ packet });
      if (drafted) {
        const verdict = checkLine(drafted, packet);
        if (verdict.ok) text = drafted;
        else {
          stats.rejected++;
          onWarn("booth recap rejected, using the written one: " + verdict.problems.slice(0, 3).join("; "));
        }
      }
    }
    if (text === fallback) stats.written++;
    return say(isFinal ? KIND.FINAL : KIND.RECAP, text, { meta: { round } });
  }

  async function open(text) {
    return say(KIND.OPEN, text || config.openText || "Welcome to the River Ranch draft.", {});
  }

  return { callPick, interject, recap, open, say, stats: () => ({ ...stats }) };
}
