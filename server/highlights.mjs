// The highlight catalogue.
//
// The design already accepts that most players will not have a clip: the
// catalogue is built in draft-position order, the owner scrubs as far as time
// allows, and everyone past that gets the animated card. That is the design, not
// a failure, so nothing here is allowed to make a missing clip cost anything.
//
// A clip is a video id plus a start second plus a ceiling. Length is a ceiling,
// never a target - the reveal cuts it short whenever picks are waiting.

import { readJsonSync, writeAtomicSync } from "./persist.mjs";

const OEMBED = "https://www.youtube.com/oembed?format=json&url=";

/** Pull a video id out of whatever form the owner pasted. */
export function videoIdFrom(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m =
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    s.match(/\/embed\/([A-Za-z0-9_-]{11})/) ||
    s.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** "1:23" or "83" or "1m23s" -> 83 */
export function toSeconds(input) {
  const s = String(input ?? "").trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const clock = s.match(/^(\d+):(\d{1,2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const m = s.match(/(?:(\d+)m)?\s*(?:(\d+)s)?/);
  return (Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0)) | 0;
}

export function createHighlights({ file = "data/highlights.json", onWarn = () => {}, onInfo = () => {} } = {}) {
  let catalog = readJsonSync(file, {}) ?? {};
  if (catalog.clips) catalog = catalog.clips; // tolerate a wrapped file

  function save() {
    writeAtomicSync(file, catalog, { onWarn });
  }

  function get(playerId) {
    const c = catalog[String(playerId)];
    if (!c || !c.videoId || c.disabled) return null;
    return c;
  }

  function set(playerId, { videoId, start = 0, ceilingMs, title = "", note = "", localOnly = false }) {
    const id = videoIdFrom(videoId);
    if (!id && !localOnly) return { ok: false, reason: "that does not look like a YouTube link" };
    catalog[String(playerId)] = {
      ...(catalog[String(playerId)] ?? {}),
      videoId: id ?? null,
      start: Math.max(0, Number(start) || 0),
      ceilingMs: Number(ceilingMs) || 8000,
      title,
      note,
      verifiedAt: 0,
    };
    save();
    return { ok: true, clip: catalog[String(playerId)] };
  }

  function remove(playerId) {
    delete catalog[String(playerId)];
    save();
    return { ok: true };
  }

  /**
   * Ask YouTube whether each video still exists and can be embedded. No API key:
   * the oEmbed endpoint answers 404 for a video that has been pulled and 401 for
   * one that forbids embedding, which is exactly the pair we care about.
   */
  async function preflight({ concurrency = 6, timeoutMs = 6000 } = {}) {
    const entries = Object.entries(catalog).filter(([, c]) => c.videoId && !c.disabled);
    const bad = [];
    let checked = 0;
    const queue = [...entries];

    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const [playerId, clip] = item;
        try {
          const url = OEMBED + encodeURIComponent("https://www.youtube.com/watch?v=" + clip.videoId);
          const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          checked++;
          if (r.ok) {
            clip.verifiedAt = Date.now();
          } else {
            clip.verifiedAt = 0;
            bad.push({ playerId, videoId: clip.videoId, status: r.status });
          }
        } catch (e) {
          checked++;
          // A network failure is not proof the clip is bad; leave it alone and
          // let the reveal's own ladder handle it on the night.
          onWarn("clip " + clip.videoId + ": " + e.message);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    save();
    onInfo(`highlights: ${checked} checked, ${bad.length} unusable`);
    return { checked, bad, total: entries.length };
  }

  return {
    get,
    set,
    remove,
    preflight,
    save,
    get size() {
      return Object.keys(catalog).filter((k) => catalog[k]?.videoId && !catalog[k].disabled).length;
    },
    get all() {
      return catalog;
    },
    /** What the reveal asks for. Never throws, never waits. */
    contentFor(card) {
      const entry = catalog[String(card.playerId)] ?? {};
      if (entry.disabled) return null;
      // A file on this disk starts on the next frame. Always prefer it.
      const local = localClip(card.playerId);
      if (local) {
        return {
          kind: "file",
          url: "/clip/" + encodeURIComponent(local.name),
          startSec: entry.start ?? 0,
          ceilingMs: entry.ceilingMs ?? 8000,
        };
      }
      const clip = get(card.playerId);
      if (!clip) return null;
      return { kind: "video", videoId: clip.videoId, startSec: clip.start, ceilingMs: clip.ceilingMs };
    },
  };
}

// ---------------------------------------------------------------- local files
//
// A local file beats an embed for one reason that has nothing to do with
// adverts: an eight-second reveal cannot carry a network dependency. An embed
// spends one to three seconds loading, negotiating and seeking before it shows
// anything, every time, and it varies with the venue's connection. A file on
// this disk starts on the next frame.
//
// The catalogue entry is the same shape either way - a start second and a
// ceiling - so a clip can be local, an embed, or neither, and the reveal treats
// all three the same.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const CLIP_DIR = "data/clips";
const VIDEO_EXT = [".mp4", ".webm", ".mov", ".m4v"];

/** The file for a player, whatever extension it was saved with. */
export function localClip(playerId, dir = CLIP_DIR) {
  for (const ext of VIDEO_EXT) {
    const f = join(dir, String(playerId) + ext);
    if (existsSync(f)) return { file: f, name: String(playerId) + ext, bytes: statSync(f).size };
  }
  return null;
}

export function localClipCount(dir = CLIP_DIR) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => VIDEO_EXT.some((e) => f.toLowerCase().endsWith(e))).length;
}

export function isVideoName(name) {
  return VIDEO_EXT.some((e) => String(name).toLowerCase().endsWith(e));
}
