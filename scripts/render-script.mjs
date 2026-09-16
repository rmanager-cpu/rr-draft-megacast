// Render a written booth segment to one mp3, in the show's real voices.
//
//   node scripts/render-script.mjs booth/recaps/2026-week01.md
//   node scripts/render-script.mjs booth/recaps/2026-week01.md out.mp3
//   node scripts/render-script.mjs booth/recaps/2026-week01.md --dry
//
// This is the sibling of `npm run finale`. The finale asks the running show to
// write a segment about the draft it just watched. This one takes a segment that
// is already written, on disk, and read by a person first - a weekly recap, a
// cold open, anything - and renders it. Nothing here talks to the show, so it
// works with the laptop closed on draft night and open on a Tuesday in November.
//
// Voices come from data/show.config.json: speaker names are matched against
// finale.cast, so Warren, Allison, Eldrin and Model 7 sound the same here as
// they do on the speaker. ElevenLabs if ELEVENLABS_API_KEY is set, OpenAI if
// only OPENAI_API_KEY is, exactly as the show decides it.
//
// Markers, each on its own line:
//   [STING]      plays data/audio/cache/sting.mp3 if it exists, skipped if not
//   [BELLS]      every line up to [SCREAM] is laid over a bed of church bells
//   [SCREAM]     plays data/audio/cache/scream.mp3
//   [HARD CUT]   a note to the reader; renders as nothing
//
// --dry prints the plan and calls nothing, which is worth doing before spending
// ElevenLabs characters on a segment this long.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { loadEnv } from "./env.mjs";
import { createVoice } from "../server/booth-voice.mjs";
import { writeBells } from "./bells.mjs";

const LEAD_SECONDS = 3.0; // bells alone before Model 7 speaks
const M7_GAP_SECONDS = 2.6; // between Model 7's lines, filled with bells
const TAIL_SECONDS = 2.0; // bells alone after the last line, before the scream
const SPEECH_GAP_SECONDS = 0.6; // a breath between speakers

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const positional = args.filter((a) => !a.startsWith("--"));
const scriptPath = positional[0];
if (!scriptPath) {
  console.error("usage: node scripts/render-script.mjs <script.md> [out.mp3] [--dry]");
  process.exit(2);
}
if (!existsSync(scriptPath)) {
  console.error("no such script: " + scriptPath);
  process.exit(2);
}

const cfg = JSON.parse(readFileSync("data/show.config.json", "utf8"));
const cast = (cfg.finale?.cast ?? []).filter((c) => c?.name && c?.voice);
if (!cast.length) {
  console.error("data/show.config.json has no finale.cast, so there is nobody to speak this");
  process.exit(2);
}

// ---------------------------------------------------------------- the script
// Names are matched loosely, the same way the booth parses a written finale:
// "MODEL 7", "Model7" and "**Model 7:**" are one speaker. Anything before the
// first marker or first speaker is treated as a header and ignored, so a script
// can carry notes about where its facts came from.

const loose = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const known = new Map(cast.map((c) => [loose(c.name), c]));

const items = [];
let started = false;
let current = null;
for (const raw of readFileSync(scriptPath, "utf8").split(/\r?\n/)) {
  const line = raw.trim().replace(/^[*_#>]+\s*/, "").replace(/[*_]+$/, "");
  if (!line) continue;
  const mark = line.match(/^\[([A-Za-z ]+)\]$/);
  if (mark) {
    started = true;
    current = null;
    items.push({ type: "mark", name: mark[1].trim().toUpperCase() });
    continue;
  }
  const said = line.match(/^([A-Za-z][A-Za-z0-9 ]{0,20}?)[*_]*\s*:[*_]*\s*(.*)$/);
  if (said && known.has(loose(said[1]))) {
    started = true;
    const who = known.get(loose(said[1]));
    current = { type: "line", speaker: who.name, voice: who.voice, text: said[2].trim() };
    items.push(current);
    continue;
  }
  // A line with no speaker continues the one above it, so a long speech can be
  // wrapped in the file without becoming two speeches.
  if (started && current) current.text += " " + line;
}
const spoken = items.filter((i) => i.type === "line" && i.text);
if (!spoken.length) {
  console.error("no speeches found. Lines must start with one of: " + cast.map((c) => c.name).join(", "));
  process.exit(2);
}

// ----------------------------------------------------------------- the plan
// Everything between [BELLS] and [SCREAM] becomes one composite piece: the lines
// mixed over a bed long enough to hold them. Everything else is one piece each.

const soundDir = "data/audio/cache";
const plan = [];
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  if (it.type === "line") {
    plan.push({ kind: "speech", ...it, gapAfter: SPEECH_GAP_SECONDS });
    continue;
  }
  if (it.name === "BELLS") {
    const lines = [];
    let j = i + 1;
    for (; j < items.length; j++) {
      if (items[j].type === "mark" && items[j].name === "SCREAM") break;
      if (items[j].type === "line" && items[j].text) lines.push(items[j]);
    }
    plan.push({ kind: "bells", lines, gapAfter: 0 });
    i = j - 1;
    continue;
  }
  if (it.name === "SCREAM" || it.name === "STING") {
    const file = join(soundDir, it.name.toLowerCase() + ".mp3");
    if (existsSync(file)) plan.push({ kind: "sound", file, label: it.name, gapAfter: it.name === "STING" ? 0.4 : 0.25 });
    else console.error(`${it.name}: ${file} is not on disk, skipping it`);
    continue;
  }
  // HARD CUT and anything else is a note to the reader.
}

if (dry) {
  console.log("");
  for (const p of plan) {
    if (p.kind === "speech") console.log(`${p.speaker} [${p.voice}]  ${p.text.slice(0, 70)}${p.text.length > 70 ? "..." : ""}`);
    else if (p.kind === "bells") console.log(`BELLS  ${p.lines.length} line(s) from ${p.lines[0]?.speaker ?? "nobody"} over the bed`);
    else console.log(`SOUND  ${p.label}`);
  }
  const chars = spoken.reduce((n, l) => n + l.text.length, 0);
  console.log(`\n${spoken.length} speeches, ${chars} characters. Nothing was rendered.`);
  process.exit(0);
}

// ---------------------------------------------------------------- the voices

const env = loadEnv();
const voices = Object.fromEntries(Object.entries(cfg.voices ?? {}).filter(([k, v]) => k !== "_" && v));
const voice = createVoice({
  apiKey: env.ELEVENLABS_API_KEY,
  openaiKey: env.OPENAI_API_KEY,
  openaiVoices: { play: env.OPENAI_VOICE_PLAY || "onyx", colour: env.OPENAI_VOICE_COLOUR || "ash" },
  voices,
  onWarn: (w) => console.error("voice:", w),
});
if (!voice.available) {
  console.error("no voice is configured. Put ELEVENLABS_API_KEY (with voice ids in data/show.config.json) or OPENAI_API_KEY in .env");
  process.exit(1);
}

const now = new Date();
const two = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
const out = resolve(positional[1] ?? `data/audio/recap-${stamp}.mp3`);
mkdirSync(dirname(out), { recursive: true });

async function render(line) {
  const r = await voice.render(line.text, { voice: line.voice, timeoutMs: 30000 });
  if (!r) {
    console.error(`\ncould not render a line for ${line.speaker}, skipping it`);
    return null;
  }
  return join(voice.dir, r.url.split("/").pop());
}

process.stdout.write("rendering");
for (const p of plan) {
  if (p.kind === "speech") {
    p.file = await render(p);
    process.stdout.write(".");
  } else if (p.kind === "bells") {
    for (const l of p.lines) {
      l.file = await render(l);
      process.stdout.write(".");
    }
    p.lines = p.lines.filter((l) => l.file);
  }
}
console.log("");

// ----------------------------------------------------------------- stitching

/** ffmpeg on the PATH, where winget puts it, or wherever FFMPEG says. */
function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  if (!spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error) return "ffmpeg";
  const pkgs = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  try {
    for (const d of readdirSync(pkgs)) {
      if (!d.startsWith("Gyan.FFmpeg")) continue;
      for (const sub of readdirSync(join(pkgs, d))) {
        const exe = join(pkgs, d, sub, "bin", "ffmpeg.exe");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {}
  return null;
}

const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  console.error("ffmpeg not found. winget install Gyan.FFmpeg, then restart the shell.");
  process.exit(1);
}
const run = (a) => spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...a], { stdio: ["ignore", "inherit", "inherit"] });

const work = join(tmpdir(), "rr-recap-" + process.pid);
mkdirSync(work, { recursive: true });

/** Clips end to end, each followed by a gap. The pattern the finale already uses. */
function concatTo(target, clips) {
  const inputs = [];
  const filters = [];
  clips.forEach((c, n) => {
    inputs.push("-i", c.file);
    filters.push(`[${n}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${Math.max(0, Number(c.gapAfter ?? 0))}[a${n}]`);
  });
  const chain = clips.map((_, n) => `[a${n}]`).join("") + `concat=n=${clips.length}:v=0:a=1[out]`;
  return run([...inputs, "-filter_complex", filters.join(";") + ";" + chain, "-map", "[out]", target]);
}

function durationOf(file) {
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
  const r = spawnSync(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const d = Number(String(r.stdout ?? "").trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

for (const p of plan) {
  if (p.kind !== "bells" || !p.lines.length) continue;
  // The lines first, spaced out, so the bells have something to fill between them.
  const seq = join(work, "m7.wav");
  const r = concatTo(seq, p.lines.map((l, n) => ({ file: l.file, gapAfter: n === p.lines.length - 1 ? 0 : M7_GAP_SECONDS })));
  if (r.status !== 0) {
    console.error("could not assemble the Model 7 lines; they will play without bells");
    p.kind = "speechGroup";
    continue;
  }
  const spokenFor = durationOf(seq) ?? p.lines.length * 8;
  const bed = join(work, "bells.wav");
  writeBells(bed, LEAD_SECONDS + spokenFor + TAIL_SECONDS);

  const mixed = join(work, "bellsmix.wav");
  const delay = Math.round(LEAD_SECONDS * 1000);
  const mix = (norm) =>
    run([
      "-i", bed, "-i", seq,
      "-filter_complex",
      `[1:a]aresample=44100,aformat=channel_layouts=mono,adelay=${delay}|${delay}[v];` +
        `[0:a][v]amix=inputs=2:duration=longest:dropout_transition=0${norm ? ":normalize=0" : ""}${norm ? "" : ",volume=2"}[out]`,
      "-map", "[out]", mixed,
    ]);
  // normalize=0 keeps both at full level, but it needs a recent ffmpeg; older
  // builds halve everything, so put the gain back by hand instead.
  if (mix(true).status !== 0 && mix(false).status !== 0) {
    console.error("could not mix the bells; the lines will play without them");
    p.kind = "speechGroup";
    continue;
  }
  p.file = mixed;
}

// A bells block that could not be mixed still has to be heard, so it falls back
// to its lines played one after another. Losing the bells must not lose Model 7.
const clips = [];
for (const p of plan) {
  if (p.kind === "speechGroup") {
    for (const l of p.lines) if (l.file) clips.push({ file: l.file, gapAfter: M7_GAP_SECONDS });
  } else if (p.file && existsSync(p.file)) {
    clips.push({ file: p.file, gapAfter: p.gapAfter ?? 0 });
  }
}
if (!clips.length) {
  console.error("nothing rendered");
  process.exit(1);
}
if (concatTo(out, clips).status !== 0) {
  console.error("ffmpeg could not stitch the segment");
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });

const txt = out.replace(/\.mp3$/i, "") + ".txt";
writeFileSync(txt, spoken.map((l) => l.speaker.toUpperCase() + ": " + l.text).join("\n\n") + "\n");
const dur = durationOf(out);
console.log(`wrote ${out}${dur ? `, ${Math.floor(dur / 60)}m ${Math.round(dur % 60)}s` : ""}`);
console.log(`script ${txt}`);
