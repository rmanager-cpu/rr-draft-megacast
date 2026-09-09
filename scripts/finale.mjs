// The closing segment, on command. Talks to the running show.
//
//   npm run finale -- --preview           write the script and print it; play nothing
//   npm run finale                        the intro, then the whole booth on the whole draft, on the studio
//   npm run finale -- --file              the same segment as one mp3: data/audio/finale-<date>.mp3
//   npm run finale -- --file out.mp3      ... at a path of your choosing
//   npm run finale -- --port 7788         if the show is on another port
//
// The writer takes a minute or two for a segment this size. Preview first if
// you want to read it before it reaches the speaker.
//
// The file is built here, not in the show: the script comes from the show's
// writer and guard, each line is rendered through the same voice module and
// cache the studio uses, and ffmpeg stitches them with a short breath between
// speakers. Without ffmpeg the mp3s are joined end to end, which most players
// cope with, and it says so.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadEnv } from "./env.mjs";
import { createVoice } from "../server/booth-voice.mjs";

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const fileFlag = args.indexOf("--file");
const wantFile = fileFlag >= 0;
const i = args.indexOf("--port");
const port = i >= 0 ? Number(args[i + 1]) : 7788;

console.log(
  wantFile ? "writing the script, then rendering it to a file..." : preview ? "writing the script..." : "writing the script, then playing it on the studio...",
);
let r;
try {
  r = await fetch(`http://127.0.0.1:${port}/api/finale`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preview: preview || wantFile }),
  });
} catch (e) {
  console.error("the show is not answering on port " + port + ": " + e.message);
  process.exit(1);
}
const j = await r.json().catch(() => ({}));
if (!j.ok) {
  console.error("finale: " + (j.reason ?? "HTTP " + r.status));
  process.exit(1);
}
console.log("");
for (const l of j.lines) console.log(l.speaker.toUpperCase() + ": " + l.text + "\n");
if (j.dropped?.length) {
  console.log("dropped by the guard:");
  for (const d of j.dropped) console.log("  " + d.speaker + ": " + d.problems.join("; "));
  console.log("");
}

if (!wantFile) {
  console.log(j.played ? "playing on the studio now." : "preview only. Run it without --preview to play it.");
  process.exit(0);
}

// ------------------------------------------------------------------ the file

const env = loadEnv();
const cfg = JSON.parse(readFileSync("data/show.config.json", "utf8"));
const voices = Object.fromEntries(Object.entries(cfg.voices ?? {}).filter(([k, v]) => k !== "_" && v));
const voice = createVoice({ apiKey: env.ELEVENLABS_API_KEY, voices, onWarn: (w) => console.error("voice:", w) });
if (!voice.available) {
  console.error("no voice is configured (ELEVENLABS_API_KEY or OPENAI_API_KEY), so there is nothing to render");
  process.exit(1);
}

// Local time, so the filename matches the clock on the wall.
const now = new Date();
const two = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
const out = resolve(args[fileFlag + 1] && !args[fileFlag + 1].startsWith("--") ? args[fileFlag + 1] : `data/audio/finale-${stamp}.mp3`);
mkdirSync(dirname(out), { recursive: true });

// The intro first, exactly as the studio would play it, then every speech.
const intro = cfg.finale?.intro ?? { steps: [] };
const parts = [];
for (const step of intro.steps ?? []) {
  if (step.sound) parts.push({ file: join(voice.dir, step.sound), label: "sound " + step.sound, gapAfter: intro.gapSeconds ?? 3 });
  else if (step.text) parts.push({ text: step.text, voice: step.voice ?? "awakening", label: "intro", gapAfter: 0.6 });
}
for (const l of j.lines) parts.push({ text: l.text, voice: l.voice, label: l.speaker, gapAfter: 0.6 });

process.stdout.write("rendering " + parts.length + " pieces");
for (const p of parts) {
  if (p.file) {
    if (!existsSync(p.file)) console.error("\nmissing " + p.file + ", skipped");
    process.stdout.write(".");
    continue;
  }
  const rendered = await voice.render(p.text, { voice: p.voice, timeoutMs: 30000 });
  if (!rendered) {
    console.error("\ncould not render a line for " + p.label + ", skipped");
    continue;
  }
  p.file = join(voice.dir, rendered.url.split("/").pop());
  process.stdout.write(".");
}
console.log("");
const clips = parts.filter((p) => p.file && existsSync(p.file));
if (!clips.length) {
  console.error("nothing rendered");
  process.exit(1);
}

/** ffmpeg on the PATH, or where winget puts it when the shell has not been restarted. */
function findFfmpeg() {
  const onPath = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (!onPath.error) return "ffmpeg";
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
if (ffmpeg) {
  // One input per clip, a breath of silence after each, all re-encoded to one
  // stream so a sound file at another rate cannot trip a player.
  const inputs = [];
  const filters = [];
  clips.forEach((c, n) => {
    inputs.push("-i", c.file);
    const gap = Math.max(0, Number(c.gapAfter ?? 0));
    filters.push(`[${n}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${gap}[a${n}]`);
  });
  const chain = clips.map((_, n) => `[a${n}]`).join("") + `concat=n=${clips.length}:v=0:a=1[out]`;
  const res = spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filters.join(";") + ";" + chain, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "160k", out], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) {
    console.error("ffmpeg failed, falling back to a plain join");
    writeFileSync(out, Buffer.concat(clips.map((c) => readFileSync(c.file))));
  }
} else {
  console.error("ffmpeg not found; joining the mp3s end to end with no gaps. winget install Gyan.FFmpeg for a proper stitch.");
  writeFileSync(out, Buffer.concat(clips.map((c) => readFileSync(c.file))));
}

// Keep the script beside the audio, so the file can be read as well as heard.
const txt = out.replace(/\.mp3$/i, "") + ".txt";
writeFileSync(txt, j.lines.map((l) => l.speaker.toUpperCase() + ": " + l.text).join("\n\n") + "\n");
console.log("wrote " + out);
console.log("script " + txt);
