// Writing to disk on draft night must never be the thing that stops the show.
//
// Two mechanisms. picks.jsonl is the durable record: one line appended the
// instant a pick commits, so a crash can lose at most the line being written.
// state.json is the convenience snapshot: whole-file, written atomically, used
// to bring a restarted process back where it was.
//
// Atomic on Windows means write to a temp file, fsync, then rename over the
// target. Rename is atomic, but antivirus and search indexers do take brief
// locks on freshly written files, so a failure is retried once and then
// downgraded to a direct write rather than allowed to propagate.

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function writeAtomicSync(path, data, { onWarn = () => {} } = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  ensureDir(dirname(path));
  const tmp = path + ".tmp";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      return true;
    } catch (e) {
      if (attempt === 1) {
        onWarn(`atomic write to ${path} failed (${e.code || e.message}); retrying`);
        continue;
      }
      // Last resort: a plain write. A torn file is recoverable from the journal;
      // a thrown exception during a live draft is not.
      try {
        writeFileSync(path, text);
        onWarn(`atomic write to ${path} fell back to a direct write`);
        return true;
      } catch (e2) {
        onWarn(`could not persist ${path}: ${e2.code || e2.message}`);
        return false;
      }
    }
  }
  return false;
}

export function readJsonSync(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Append-only journal. One JSON object per line; a bad line never kills a read. */
export function createJournal(path, { onWarn = () => {} } = {}) {
  ensureDir(dirname(path));
  return {
    append(obj) {
      try {
        appendFileSync(path, JSON.stringify(obj) + "\n");
      } catch (e) {
        onWarn(`journal append failed: ${e.code || e.message}`);
      }
    },
    readAll() {
      if (!existsSync(path)) return [];
      const out = [];
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          onWarn("skipped a damaged journal line");
        }
      }
      return out;
    },
    path,
  };
}
