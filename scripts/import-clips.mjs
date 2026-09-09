// Import Dansky's "Draft Highlights" clips into data/clips/<playerId>.<ext>.
//
// The reveal prefers a local file over an embed (server/highlights.mjs), and it
// finds that file purely by name: data/clips/<playerId>.mp4. So importing is a
// rename, nothing more. Titles are written into the catalogue so the curate page
// shows something sensible next to each player; start stays 0 and the ceiling
// stays the 8s default until you scrub them.
//
//   node scripts/import-clips.mjs --from "C:/Users/AlexM/Downloads/Draft Highlights"
//   node scripts/import-clips.mjs --from <dir> --move      (move instead of copy)
//   node scripts/import-clips.mjs --from <dir> --dry-run
//
// Matching is by exact source filename, taken from scripts/clipmap.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const FROM = val("--from");
const DRY = flag("--dry-run");
const MOVE = flag("--move");
const CLIP_DIR = "data/clips";
const CATALOG = "data/highlights.json";

if (!FROM) { console.error("need --from <dir>  (the folder holding the downloaded .mp4 files)"); process.exit(1); }
if (!existsSync(FROM)) { console.error("no such folder: " + FROM); process.exit(1); }

const map = JSON.parse(readFileSync(new URL("./clipmap.json", import.meta.url), "utf8"));
const byFilename = new Map(map.map((m) => [m.filename, m]));

// Drive/Windows sanitise some characters on download; compare on a loose key too.
const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const byLoose = new Map(map.map((m) => [loose(m.filename), m]));

const present = readdirSync(FROM).filter((f) => /\.(mp4|webm|mov|m4v)$/i.test(f));
if (!present.length) { console.error("no video files in " + FROM); process.exit(1); }

if (!DRY) mkdirSync(CLIP_DIR, { recursive: true });

const done = [], skipped = [], unknown = [];
for (const f of present) {
  const m = byFilename.get(f) ?? byLoose.get(loose(f));
  if (!m) { unknown.push(f); continue; }
  const ext = extname(f).toLowerCase();
  const dest = join(CLIP_DIR, m.playerId + ext);
  if (existsSync(dest)) { skipped.push(`${m.player} (already there)`); continue; }
  if (!DRY) {
    // --move across mount points falls back to a copy; the source folder is left
    // for you to delete, since this shell is not permitted to remove files.
    if (MOVE) { try { renameSync(join(FROM, f), dest); } catch (e) { if (e.code !== "EXDEV") throw e; copyFileSync(join(FROM, f), dest); } }
    else copyFileSync(join(FROM, f), dest);
  }
  done.push({ ...m, dest, bytes: statSync(join(FROM, f)).size });
}

// Catalogue entries: title only. A local file plays even with no entry at all,
// but a title makes the curate page readable and gives you somewhere to scrub.
if (!DRY && done.length) {
  const cat = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, "utf8")) : {};
  for (const d of done) {
    const k = String(d.playerId);
    cat[k] = { videoId: null, start: 0, ceilingMs: 8000, title: d.player, note: d.note || "", verifiedAt: 0, ...(cat[k] ?? {}) };
    cat[k].title ||= d.player;
  }
  writeFileSync(CATALOG, JSON.stringify(cat, null, 2));
}

done.sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
console.log(`${DRY ? "[dry run] " : ""}imported ${done.length}, skipped ${skipped.length}, unrecognised ${unknown.length}`);
if (done.length) {
  console.log("\ntop of the board now covered:");
  for (const d of done.slice(0, 12)) console.log(`  ${String(d.adp).padStart(5)}  ${d.player.padEnd(24)} -> ${d.dest}`);
  if (done.length > 12) console.log(`  ... and ${done.length - 12} more`);
}
if (skipped.length) console.log("\nskipped:\n  " + skipped.join("\n  "));
if (unknown.length) console.log("\nnot in the map (left alone):\n  " + unknown.join("\n  "));

const missing = map.filter((m) => !done.some((d) => d.playerId === m.playerId) && !existsSync(join(CLIP_DIR, m.playerId + ".mp4")));
if (missing.length) console.log(`\nstill missing ${missing.length} of ${map.length}:\n  ` + missing.map((m) => m.player).join(", "));
