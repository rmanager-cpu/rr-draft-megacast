// Build the booth's player notes from ESPN's own season outlooks.
//
// This matters more than it looks. The booth may only say what is in the packet,
// and the banned-subject check unlocks a subject only when that player's note
// covers it. So the notes are both the colour the booth has to work with and the
// boundary of what it is allowed to touch - and because they are ESPN's words
// rather than invented ones, nothing here is a guess.
//
// Usage: node scripts/player-notes.mjs [--top 250] [--sentences 2]
import { writeAtomicSync } from "../server/persist.mjs";
import { loadPlayers } from "../server/players.mjs";
import { loadEnv } from "./env.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? Number(args[i + 1]) : d;
};
const top = flag("top", 250);
const maxSentences = flag("sentences", 2);

const env = loadEnv();
const players = await loadPlayers({ season: Number(env.ESPN_SEASON || 2026), onInfo: console.log, onWarn: console.warn });

/** Keep the first couple of sentences: enough to be useful, short enough to check. */
function trim(text) {
  const clean = String(text)
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
  const parts = [];
  let last = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    if (!".!?".includes(clean[i])) continue;
    const next = clean.slice(i + 1);
    // A real sentence break is a stop, a space, then a capital. Checked without
    // a regex on purpose: escapes do not survive being edited through a shell,
    // and a silently broken pattern here returns the whole raw blob instead.
    if (clean[i + 1] !== " ") continue;
    const after = clean[i + 2];
    if (!after || after === after.toLowerCase()) continue;
    parts.push(clean.slice(last, i + 1).trim());
    last = i + 1;
    if (parts.length >= maxSentences) break;
  }
  if (parts.length < maxSentences && last < clean.length) parts.push(clean.slice(last).trim());
  // Never end on a fragment: the source outlook is itself capped, so the tail
  // can be half a word.
  const kept = parts.slice(0, maxSentences).filter((s, k, all) => k < all.length - 1 || /[.!?]$/.test(s));
  return kept.join(" ").trim();
}

const notes = {};
let withNote = 0;
for (const p of players.byAdp.slice(0, top)) {
  if (!p.outlook) continue;
  const note = trim(p.outlook);
  if (note.length < 40) continue;
  notes[String(p.id)] = note;
  withNote++;
}

writeAtomicSync("data/player-notes.json", notes, { onWarn: console.warn });

const subjects = Object.values(notes).filter((n) => /injur|hamstring|acl|suspend|trade|holdout/i.test(n)).length;
console.log(`${withNote} of the top ${top} have a note.`);
console.log(`${subjects} of them mention something the booth would otherwise be forbidden to raise.`);
console.log("Skim data/player-notes.json before the draft - anything in there, the booth may say.");
