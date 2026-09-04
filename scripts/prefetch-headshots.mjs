// Pull the headshots for the top of the board onto disk the day before, so the
// studio keeps drawing cards with the network unplugged.
// Usage: node scripts/prefetch-headshots.mjs [--top 400]
import { loadPlayers } from "../server/players.mjs";
import { createHeadshots } from "../server/headshots.mjs";
import { loadEnv } from "./env.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--top");
const top = i >= 0 ? Number(args[i + 1]) : 400;

const env = loadEnv();
const players = await loadPlayers({ season: Number(env.ESPN_SEASON || 2026), onInfo: console.log, onWarn: console.warn });
const headshots = createHeadshots({ onWarn: (w) => console.warn(w) });

const wanted = players.byAdp.slice(0, top).map((p) => ({ playerId: p.id, proTeam: p.proTeam }));
// Every defense as well: they use a team badge and there are only thirty-two.
for (const p of players.all) if (p.pos === "D/ST") wanted.push({ playerId: p.id, proTeam: p.proTeam });

console.log(`fetching ${wanted.length} images...`);
let lastLogged = 0;
const { done, have } = await headshots.prefetch(wanted, {
  onProgress: (d) => {
    if (d - lastLogged < 50) return;
    lastLogged = d;
    process.stdout.write(`  ${d}/${wanted.length}\r`);
  },
});
console.log(`\n${have} of ${done} images are on disk. The rest fall back to the card, which is the design.`);
