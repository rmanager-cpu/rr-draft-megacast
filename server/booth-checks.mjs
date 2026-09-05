// Nothing reaches the speaker without passing through here.
//
// The rule from the show bible is simple and absolute: the booth may only say
// what is in the packet. Numbers must be numbers we handed it. Names must be
// names we handed it. Anything that asserts an injury, a trade, a suspension or
// a release is banned outright unless the player's own note says so, because
// those are the inventions that would actually embarrass someone in the room.
//
// These are deterministic string checks that run before the model-based checker
// and before any audio is made. They are cheap, they cannot themselves fail
// open, and they are the reason a wrong line costs a fallback rather than a
// retraction.

const TRAILING_DOT = new RegExp(String.fromCharCode(92) + ".$");

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

// Claims about a person's situation that we have no business making up.
const BANNED = [
  { re: /\binjur\w*/i, word: "injury" },
  { re: /\bhurt\b/i, word: "injury" },
  { re: /\b(tore|torn|acl|hamstring|concussion)\b/i, word: "injury" },
  { re: /\btrade[ds]?\b/i, word: "trade" },
  { re: /\bsuspend\w*|\bsuspension\b/i, word: "suspension" },
  { re: /\b(cut|released|waived)\b/i, word: "release" },
  { re: /\bholdout\b|\bholding out\b/i, word: "holdout" },
  { re: /\bretire\w*/i, word: "retirement" },
  { re: /\barrest\w*|\bcharged\b/i, word: "legal" },
];

/** Words that look like names but are ordinary language. */
const COMMON = new Set([
  "the", "a", "an", "and", "but", "so", "then", "now", "here", "there", "this", "that",
  "he", "his", "him", "they", "their", "we", "i", "it", "its", "you",
  "round", "pick", "board", "draft", "team", "back", "up", "off", "on", "in", "at", "to",
  "if", "when", "what", "who", "how", "why", "well", "yes", "no", "ok", "okay",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // Ordinary football vocabulary that happens to start a clause.
  "board", "clock", "value", "reach", "steal", "run", "sleeper", "bench", "starter",
  "rookie", "veteran", "season", "yards", "targets", "carries", "touchdowns", "points",
]);

/**
 * @param {string} text        what the booth wants to say
 * @param {object} packet      the facts it was given
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkLine(text, packet = {}) {
  const problems = [];
  const line = String(text ?? "").trim();
  if (!line) return { ok: false, problems: ["empty"] };
  if (line.length > (packet.maxChars ?? 1400)) problems.push("too long");

  const allowedNumbers = new Set((packet.numbers ?? []).map(Number).filter((n) => Number.isFinite(n)));
  // Round and pick numbers are always fair game if the packet named them.
  for (const n of [packet.round, packet.pick, packet.slotInRound]) if (Number.isFinite(n)) allowedNumbers.add(Number(n));
  // So is anything the note itself states: it is packet content, not invention.
  const noteText = String(packet.notes ?? "");
  // Scanned character by character rather than with a pattern: escape sequences
  // do not survive being edited through a shell, and a silently broken pattern
  // here would quietly forbid every fact the note actually states.
  let run = "";
  for (const ch of noteText + " ") {
    const isDigit = ch >= "0" && ch <= "9";
    if (isDigit || (run && (ch === "." || ch === ","))) {
      run += ch;
      continue;
    }
    if (run) {
      const n = Number(run.split(",").join("").replace(TRAILING_DOT, ""));
      if (Number.isFinite(n)) allowedNumbers.add(n);
      run = "";
    }
  }

  for (const m of line.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    const n = Number(m[0]);
    if (!allowedNumbers.has(n)) problems.push(`number ${m[0]} is not in the packet`);
  }
  for (const m of line.matchAll(/\b[a-z]+\b/gi)) {
    const w = m[0].toLowerCase();
    if (!(w in NUMBER_WORDS)) continue;
    // Ordinals up to the round count are safe; anything else must be in the packet.
    const v = NUMBER_WORDS[w];
    if (allowedNumbers.has(v)) continue;
    if (v <= 12 && /first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|one|two|three|four|five|six|seven|eight|nine|ten/.test(w)) continue;
    problems.push(`"${w}" is a number that is not in the packet`);
  }

  const whitelist = new Set(
    [...(packet.names ?? []), ...noteText.split(/[^A-Za-z'’-]+/)]
      .flatMap((n) => String(n).split(/[\s.'-]+/))
      .map((w) => w.toLowerCase())
      .filter(Boolean),
  );
  for (const m of line.matchAll(/\b[A-Z][a-zA-Z'’-]+\b/g)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (COMMON.has(lower) || whitelist.has(lower)) continue;
    // Short all-capitals tokens are abbreviations, not people: ADP, WR, PPR, MIN.
    if (w.length <= 4 && w === w.toUpperCase()) continue;
    // A capitalised word that opens a sentence is usually just a sentence.
    const idx = m.index ?? 0;
    const before = line.slice(0, idx).trimEnd();
    if (!before || /[.!?]$/.test(before)) continue;
    problems.push(`"${w}" is not a name we gave it`);
  }

  const notes = String(packet.notes ?? "").toLowerCase();
  for (const b of BANNED) {
    if (!b.re.test(line)) continue;
    if (notes && b.re.test(notes)) continue; // the note says so, so it may be said
    problems.push(`says something about ${b.word}, which is not in the notes`);
  }

  return { ok: problems.length === 0, problems };
}

/** Everything the booth is allowed to know about one pick. */
export function pickPacket({ card, league, players, note = "" }) {
  const names = [card.name, card.teamName, card.manager, card.proTeam].filter(Boolean);
  for (const t of league?.teams ?? []) {
    if (t.name) names.push(t.name);
    if (t.manager) names.push(t.manager);
  }
  const numbers = [card.pick, card.round, card.slotInRound];
  if (card.adp) numbers.push(card.adp, Math.round(card.adp));
  return {
    kind: "pick",
    pick: card.pick,
    round: card.round,
    slotInRound: card.slotInRound,
    player: card.name,
    position: card.pos,
    proTeam: card.proTeam,
    team: card.teamName,
    manager: card.manager,
    adp: card.adp ?? null,
    names,
    numbers,
    notes: note,
    maxChars: 240,
  };
}

/**
 * Pull the sayable facts out of a free-text file the owner wrote.
 *
 * The guard only lets the booth say what is in the packet, which is what keeps
 * it from inventing things about real people. But it means the lore file is
 * inert unless its contents are handed over too. So anything written there -
 * a name, a year, a score - becomes allowed, and anything not written there
 * stays refused. The file is the boundary, which is the right place for the
 * owner to control it.
 */
export function factsFrom(text) {
  const s = String(text ?? "");
  const names = [];
  for (const m of s.matchAll(/\b[A-Z][A-Za-z'\u2019-]+\b/g)) names.push(m[0]);

  const numbers = [];
  let run = "";
  for (const ch of s + " ") {
    const isDigit = ch >= "0" && ch <= "9";
    if (isDigit || (run && (ch === "." || ch === ","))) {
      run += ch;
      continue;
    }
    if (run) {
      const n = Number(run.split(",").join("").replace(TRAILING_DOT, ""));
      if (Number.isFinite(n)) numbers.push(n);
      run = "";
    }
  }
  return { names: [...new Set(names)], numbers: [...new Set(numbers)] };
}
