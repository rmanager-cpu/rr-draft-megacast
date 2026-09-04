// Player images, cached to disk on first sight.
//
// The studio must not depend on the network at reveal time, so every image we
// ever fetch is written through to data/headshots/ and served from there after.
// scripts/prefetch-headshots.mjs warms the top of the board the day before, and
// after that the reveal works with the cable out.
//
// A defense has a negative player id and no headshot; it gets its team logo.
// Anything we cannot find returns 404 quickly, and the page falls back to the
// silhouette card - which is the design, not a failure.

import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./persist.mjs";

const HEADSHOT = (id) => `https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`;
const TEAM_LOGO = (abbrev) => `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbrev).toLowerCase()}.png`;

export function createHeadshots({ dir = "data/headshots", onWarn = () => {} } = {}) {
  ensureDir(dir);
  const missing = new Set(); // do not hammer ESPN for something that is not there
  const inflight = new Map();

  const pathFor = (key) => join(dir, key + ".png");

  async function ensure(key, url) {
    if (existsSync(pathFor(key))) return true;
    if (missing.has(key)) return false;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) {
          missing.add(key);
          return false;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 512) {
          missing.add(key);
          return false;
        }
        await writeFile(pathFor(key), buf);
        return true;
      } catch (e) {
        onWarn(`headshot ${key}: ${e.message}`);
        return false;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  /** Warm the cache ahead of time. Returns how many are now on disk. */
  async function prefetch(entries, { concurrency = 8, onProgress = () => {} } = {}) {
    let done = 0;
    let have = 0;
    const list = [...entries];
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const item = list.shift();
        if (!item) return;
        const ok = await ensure(keyOf(item), urlOf(item));
        done++;
        if (ok) have++;
        onProgress(done, have);
      }
    });
    await Promise.all(workers);
    return { done, have };
  }

  const keyOf = (e) => (e.playerId < 0 ? "team-" + String(e.proTeam ?? "").toLowerCase() : String(e.playerId));
  const urlOf = (e) => (e.playerId < 0 ? TEAM_LOGO(e.proTeam) : HEADSHOT(e.playerId));

  /** Route handler for GET /img/headshot/:id  (optionally ?team=SF for a defense). */
  async function serve({ res, params, url }) {
    const id = Number(params.id);
    const team = url.searchParams.get("team") ?? "";
    const entry = { playerId: id, proTeam: team };
    const key = keyOf(entry);
    const ok = await ensure(key, urlOf(entry));
    if (!ok || !existsSync(pathFor(key))) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
    createReadStream(pathFor(key)).pipe(res);
  }

  return { serve, prefetch, ensure, keyOf, urlOf, get missingCount() { return missing.size; } };
}
