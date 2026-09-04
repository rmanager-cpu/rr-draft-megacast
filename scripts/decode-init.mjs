// Decode ESPN draft-room INIT blobs captured in spike/out/ws-frames.log.
// The frame is "INIT <b64> <b64> ..." — space-separated 2048-char base64 chunks
// of one binary payload. Goal: find how picks-so-far are encoded so the watcher
// can recover mid-draft. We know init-2 (PPR mock 1814994619) was captured with
// 6 picks made: 4685382, 4241389, 4262921, 4362238, 3929630, 4047646.
import { readFileSync } from "node:fs";

const KNOWN = {
  1: { league: 1979635407, picks: [] }, // auction, captured pre-first-sale
  2: { league: 1814994619, picks: [4685382, 4241389, 4262921, 4362238, 3929630, 4047646] },
};

const lines = readFileSync("spike/out/ws-frames.log", "utf8")
  .split(/\r?\n/)
  .filter((l) => l.includes(" RECV INIT "));

lines.forEach((line, idx) => {
  const n = idx + 1;
  const b64 = line.split(" RECV INIT ")[1].replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  console.log("== INIT " + n + " (league " + KNOWN[n].league + "): " + buf.length + " bytes ==");

  // Where do known 4-byte big-endian values sit?
  const findU32 = (val) => {
    const hits = [];
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32BE(i) === val) hits.push(i);
    return hits;
  };
  console.log("league id at offsets:", findU32(KNOWN[n].league).join(",") || "none");
  for (const p of KNOWN[n].picks) console.log("  player " + p + " at:", findU32(p).join(",") || "none");

  // Header dump: first 40 uint32BE values with offsets.
  const head = [];
  for (let i = 0; i + 4 <= Math.min(buf.length, 160); i += 4) head.push(i + ":" + buf.readUInt32BE(i));
  console.log("head u32:", head.join(" "));

  // ASCII islands (SWIDs, names?): runs of >= 8 printable chars.
  const ascii = [];
  let run = "";
  let runAt = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 32 && c < 127) {
      if (!run) runAt = i;
      run += String.fromCharCode(c);
    } else {
      if (run.length >= 8) ascii.push(runAt + ':"' + run.slice(0, 60) + '"');
      run = "";
    }
  }
  if (run.length >= 8) ascii.push(runAt + ':"' + run.slice(0, 60) + '"');
  console.log("ascii runs:", ascii.slice(0, 12).join("  ") || "none");
  console.log();
});
