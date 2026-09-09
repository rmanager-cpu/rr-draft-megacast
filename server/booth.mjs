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

/**
 * The written recap, used whenever the writer cannot be trusted or reached.
 * Commentary on the interesting picks only. The rest of the round is not read
 * back: the board is on the wall.
 */
export function writtenRecap(picks, { round, interesting = [] } = {}) {
  if (!picks.length) return "";
  const parts = [];
  parts.push(round ? `That is round ${round}.` : "That is the draft.");
  for (const p of interesting.slice(0, 3)) parts.push(whyLine(p));
  if (!interesting.length) parts.push("Nothing on that board anyone would argue with. Back to the room.");
  return parts.join(" ");
}

/** One line of the written fallback, for a pick worth a word. */
function whyLine(p) {
  if (p.reasons.includes("value")) return `${p.card.name} was still there at ${p.card.pick}.`;
  if (p.reasons.includes("reach")) return `${p.card.teamName} went early on ${p.card.name}.`;
  if (p.reasons.includes("run")) return `the ${p.card.pos} run kept going through ${p.card.name}.`;
  return `${p.card.teamName} took ${p.card.name}.`;
}

/** The written finale: no writer, no network. The stories of the draft, then good night. */
export function writtenFinale(picks, { interesting = [] } = {}) {
  if (!picks.length) return "";
  const parts = ["That is the draft. Sixteen rounds, and the board is on the wall."];
  for (const p of interesting.slice(0, 5)) parts.push(whyLine(p));
  parts.push("Thanks for coming. Good night from the River Ranch.");
  return parts.join(" ");
}

/**
 * Split a scripted segment into speeches. A line that opens with a known
 * speaker's name and a colon starts a speech; any other line continues the
 * one before it. Names match loosely - "MODEL 7", "Model7" and "**MODEL 7:**"
 * are the same speaker - because the writer's formatting is not to be trusted.
 */
export function parseScript(text, speakers) {
  const loose = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const known = new Map(speakers.map((s) => [loose(s), s]));
  const out = [];
  let current = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^[*_#>-]+\s*/, "").replace(/[*_]+$/, "");
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9 ]{0,20}?)[*_]*\s*:[*_]*\s*(.*)$/);
    if (m && known.has(loose(m[1]))) {
      current = { speaker: known.get(loose(m[1])), text: m[2].trim() };
      out.push(current);
    } else if (current) {
      current.text += " " + line;
    }
  }
  return out.filter((l) => l.text);
}

const DEFAULT_CAST = [
  { name: "Warren", voice: "host" },
  { name: "Allison", voice: "play" },
  { name: "Eldrin", voice: "colour" },
  { name: "Model 7", voice: "awakening" },
];
const DEFAULT_INTRO = {
  steps: [{ voice: "awakening", text: 'Initializing Model 7. <break time="2.5s" /> Initializing Model 7.' }, { sound: "scream.mp3" }],
  gapSeconds: 3,
};

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
  // Who says what. Three voices: play-by-play calls the picks, colour reacts
  // to them, and the host opens the show and reads the recaps. A voice that is
  // not configured falls back to play-by-play inside the voice module.
  const VOICE = { [KIND.NAME]: "play", [KIND.INTERJECT]: "colour", [KIND.RECAP]: "host", [KIND.FINAL]: "host", [KIND.OPEN]: "host", [KIND.BIT]: "host" };
  const persona = (which) => String(config.personas?.[which] ?? "").trim();
  const loreFacts = factsFrom(lore);
  const stats = { calls: 0, written: 0, generated: 0, rejected: 0, recaps: 0 };

  /** Put a line on the speaker, with sound if we have it and the system voice if not. */
  async function say(kind, text, { voice: which = VOICE[kind] ?? "play", meta = {}, expiresAt } = {}) {
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
    const text = await writer.line({ packet, persona: persona("colour"), timeoutMs: windowMs });
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
    // The standing leans always get a word: config.recapLeans maps a team id to
    // "love" or "dislike". Then the most interesting of the rest, up to
    // opinionsPerRecap. Everything else goes unmentioned; the board is on the wall.
    // recapLeansByRound overrides a lean for one round, e.g. the last one.
    const leans = { ...(config.recapLeans ?? {}), ...(config.recapLeansByRound?.[String(round)] ?? {}) };
    const leaned = picks
      .filter((card) => leans[String(card.teamId)])
      .map((card) => ({ card, score: 100, reasons: ["lean: " + leans[String(card.teamId)]] }));
    const ranked = [
      ...leaned,
      ...picks
        .filter((card) => !leans[String(card.teamId)])
        .map((card) => ({ card, ...interestOf(card, {}) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, config.opinionsPerRecap ?? 4),
    ];

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
      const drafted = await writer.recap({ packet, persona: persona("host") });
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

  /** Steps that speak or play a sound, in order, then a beat of silence. */
  async function awaken(steps, gapSeconds, kind = KIND.OPEN) {
    for (const step of steps) {
      if (step.sound) {
        // A sound file, no words. It lives in data/audio/cache like a rendered line.
        const audioUrl = "/audio/" + step.sound;
        const res = audio.enqueue({ kind, text: "", audioUrl, meta: { sound: step.sound } });
        if (res.queued) onSay({ kind, text: "", audioUrl, meta: { sound: step.sound } });
      } else if (step.text) {
        await say(kind, step.text, { voice: step.voice ?? "awakening" });
      }
    }
    const gap = Number(gapSeconds ?? 0) * 1000;
    if (steps.length && gap > 0) await new Promise((r) => setTimeout(r, gap));
  }

  /**
   * The closing segment, on command: the intro, then the whole booth on the whole
   * draft. Each speech is checked on its own, so one bad line costs one line, not
   * the segment. With too few survivors, or no writer, the host reads the written one.
   * preview returns the script and plays nothing.
   */
  async function finale({ picks = [], preview = false } = {}) {
    const fin = config.finale ?? {};
    const cast = (fin.cast ?? DEFAULT_CAST).filter((c) => c?.name && c?.voice);
    const voiceOf = Object.fromEntries(cast.map((c) => [c.name.toUpperCase(), c.voice]));
    // The standing leans come first, as in the round recaps: a leaned team's early
    // picks and any of its picks worth a word, plus any round-specific lean. Then
    // the most interesting of everyone else's, up to opinions.
    const leans = config.recapLeans ?? {};
    const byRound = config.recapLeansByRound ?? {};
    const leaned = [];
    for (const card of picks) {
      const special = byRound[String(card.round)]?.[String(card.teamId)];
      const standing = leans[String(card.teamId)];
      if (special) leaned.push({ card, score: 100, reasons: ["lean: " + special] });
      else if (standing && (card.round <= (fin.leanRounds ?? 3) || interestOf(card, {}).score > 0)) {
        leaned.push({ card, score: 90, reasons: ["lean: " + standing] });
      }
    }
    const ranked = [
      ...leaned,
      ...picks
        .filter((card) => !leans[String(card.teamId)])
        .map((card) => ({ card, ...interestOf(card, {}) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, fin.opinions ?? 10),
    ];
    let lines = [{ speaker: cast[0]?.name ?? "Warren", text: writtenFinale(picks, { interesting: ranked }) }];
    const dropped = [];

    if (writer?.available && picks.length) {
      const byTeam = new Map();
      for (const c of picks) {
        if (!byTeam.has(c.teamId)) byTeam.set(c.teamId, { team: c.teamName, manager: c.manager, picks: [] });
        byTeam.get(c.teamId).picks.push({ pick: c.pick, round: c.round, player: c.name, pos: c.pos, proTeam: c.proTeam, adp: c.adp ?? null });
      }
      const packet = {
        kind: "finale",
        seconds: fin.seconds ?? 240,
        speakers: cast.map((c) => c.name.toUpperCase()),
        teams: [...byTeam.values()],
        interesting: ranked.map((r) => ({ pick: r.card.pick, player: r.card.name, team: r.card.teamName, why: r.reasons })),
        names: [
          ...picks.flatMap((c) => [c.name, c.teamName, c.manager, c.proTeam]),
          ...(getLeague().teams ?? []).flatMap((t) => [t.name, t.manager]),
          ...cast.map((c) => c.name),
          ...loreFacts.names,
        ].filter(Boolean),
        numbers: [
          ...new Set([
            ...picks.map((c) => c.pick),
            ...picks.map((c) => c.adp).filter(Boolean),
            ...picks.map((c) => c.round),
            picks.length,
            byTeam.size,
            7,
            ...loreFacts.numbers,
          ]),
        ],
        notes: picks.map((c) => notesFor(c.playerId)).filter(Boolean).join(" "),
        maxChars: fin.maxCharsPerLine ?? 700,
      };
      const castText = cast.map((c) => persona(c.persona ?? c.voice)).filter(Boolean).join("\n\n");
      const drafted = await writer.script({ packet, cast: castText, timeoutMs: (fin.writerSeconds ?? 120) * 1000 });
      const kept = [];
      for (const l of drafted ? parseScript(drafted, cast.map((c) => c.name)) : []) {
        const verdict = checkLine(l.text, packet);
        if (verdict.ok) kept.push(l);
        else {
          stats.rejected++;
          dropped.push({ ...l, problems: verdict.problems });
          onWarn("finale line dropped (" + l.speaker + "): " + verdict.problems.slice(0, 2).join("; "));
        }
      }
      if (kept.length >= (fin.minLines ?? 4)) {
        lines = kept;
        stats.generated++;
      } else {
        stats.written++;
        onWarn("finale: only " + kept.length + " lines survived the checks, reading the written one");
      }
    } else {
      stats.written++;
    }

    const out = lines.map((l) => ({ speaker: l.speaker, voice: voiceOf[l.speaker.toUpperCase()] ?? "host", text: l.text }));
    if (preview) return { lines: out, dropped, played: false };
    const intro = fin.intro ?? DEFAULT_INTRO;
    await awaken(intro.steps ?? [], intro.gapSeconds, KIND.FINAL);
    for (const l of out) await say(KIND.FINAL, l.text, { voice: l.voice, meta: { finale: true, speaker: l.speaker } });
    return { lines: out, dropped, played: true };
  }

  async function open(text) {
    // The awakening: something speaks before the host does. Configured in
    // show.config.json, said in its own voice, then a beat, then the welcome.
    const wake = config.awakening;
    const steps = wake?.steps ?? (wake?.text ? [{ voice: "awakening", text: wake.text }] : []);
    await awaken(steps, wake?.gapSeconds, KIND.OPEN);
    const welcome = await say(KIND.OPEN, text || config.openText || "Welcome to the River Ranch draft.", {});
    // Then the booth talks among themselves for a moment. Pre-written, in order.
    for (const line of config.openBanter?.lines ?? []) {
      if (line?.text) await say(KIND.OPEN, line.text, { voice: line.voice ?? "host" });
    }
    return welcome;
  }

  return { callPick, interject, recap, open, finale, say, stats: () => ({ ...stats }) };
}
