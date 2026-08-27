// Tiny .env loader (no dependency). KEY=VALUE per line, # comments, quotes optional.
import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env") {
  const out = { ...process.env };
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const dq = val.startsWith('"') && val.endsWith('"');
    const sq = val.startsWith("'") && val.endsWith("'");
    if (dq || sq) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function requireLeague(env) {
  const id = env.ESPN_LEAGUE_ID;
  if (!id || id === "replace_me") {
    console.error("ESPN_LEAGUE_ID is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  return { id, season: env.ESPN_SEASON || "2026" };
}
