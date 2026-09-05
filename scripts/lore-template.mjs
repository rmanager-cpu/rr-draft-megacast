// Lay out data/lore.md with this league's twelve managers, in draft order, so
// the file is fill-in rather than blank page.
//   npm run lore
//
// It refuses to overwrite a lore file that has real writing in it. Losing that
// would be the worst thing this repository could do to its owner.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchLeague } from "../server/league.mjs";
import { loadEnv } from "./env.mjs";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const OUT = "data/lore.md";
const env = loadEnv();
const leagueId = process.argv.find((a) => /^\d+$/.test(a)) || env.ESPN_LEAGUE_ID;

// Whether this file is still an untouched template is answered exactly rather
// than by counting words: the template has instructional prose of its own, and
// a word count mistook that for the owner's writing. The generated file carries
// a fingerprint of itself. If the file still matches its fingerprint nobody has
// touched it and it can be replaced. If it does not, somebody wrote something,
// and losing that would be the worst thing this repository could do to them.
const STAMP = "<!-- generated-template ";

export function fingerprint(body) {
  return createHash("sha1").update(body.split(CR + LF).join(LF).trim()).digest("hex").slice(0, 16);
}

export function untouched(text) {
  const lines = text.split(CR + LF).join(LF).split(LF);
  const i = lines.findIndex((l) => l.startsWith(STAMP));
  if (i < 0) return false;
  const stamped = lines[i].slice(STAMP.length).split("-->")[0].trim();
  const body = lines.filter((_, k) => k !== i).join(LF);
  return stamped === fingerprint(body);
}

const runningDirectly = process.argv[1] && process.argv[1].endsWith("lore-template.mjs");
const force = process.argv.includes("--force");
if (runningDirectly && existsSync(OUT) && !force && !untouched(readFileSync(OUT, "utf8"))) {
  console.error("data/lore.md has writing in it. Not touching it.");
  console.error("Pass --force if you really want to replace it.");
  process.exitCode = 1;
}
if (runningDirectly && !process.exitCode) {
  const league = await fetchLeague({
    season: Number(env.ESPN_SEASON || 2026),
    leagueId,
    cookie: "SWID=" + env.ESPN_SWID + "; espn_s2=" + env.ESPN_S2,
  });

  const order = league.pickOrder.length ? league.pickOrder : league.teams.map((t) => t.id);
  const head = [
    "# The league",
    "",
    "Everything the booth knows about these people. **Whatever is written here, it may say.",
    "Whatever is not, it cannot.** That cuts both ways, so it is worth reading twice.",
    "",
    "- Write the details you want said. A joke with the year left out will not get the year,",
    "  because the booth is not allowed to supply one.",
    "- Do not write anything you would not want played through a speaker, at volume, in a",
    "  room containing the person it is about.",
    "- Facts only. The booth cannot tell whether something is true, only whether you wrote it.",
    "",
    "Two or three thousand words is plenty. A couple of hundred per manager.",
    "",
    "---",
    "",
    "## The league itself",
    "",
    "<!-- How long it has run. What the name means. The trophy, and what it is called. The",
    "     punishment for last place. The buy-in, if that gets said out loud. Anything that",
    "     gets referenced every single year. Write the years you want quoted. -->",
    "",
    "## House rules worth a mention",
    "",
    "<!-- The one rule everybody argues about. Trade veto history. Anything unusual. -->",
    "",
    "## This year",
    "",
    "<!-- Who is defending. Who came last and is owed grief for it. Anyone new. Anything",
    "     that has changed since last season. -->",
    "",
    "## Rivalries and running jokes",
    "",
    "<!-- Who needles whom, and about what. This is what makes a recap sound like your",
    "     league rather than a broadcast. -->",
    "",
    "---",
    "",
    "## The managers",
    "",
    "In draft order. For each: how they draft, what they always do, the thing everyone still",
    "brings up, and how the booth should lean on them.",
    "",
  ];

  const blocks = [];
  order.forEach((teamId, i) => {
    const t = league.teams.find((x) => x.id === teamId);
    if (!t) return;
    blocks.push(
      "### " + (t.manager || "?") + "  -  " + (t.name || "").trim(),
      "",
      "*Picks " + (i + 1) + " of " + order.length + ".*",
      "",
      "<!-- How they draft: -->",
      "<!-- What they always do: -->",
      "<!-- The thing everyone brings up: -->",
      "<!-- Lean - skeptical, impressed, or straight: -->",
      "",
    );
  });

  const tail = [
    "---",
    "",
    "## Never say",
    "",
    "<!-- The booth already refuses to invent injuries, trades, suspensions and the like.",
    "     Write down anything else you would hate to hear and it will be treated as banned. -->",
    "",
    "## Pronunciations",
    "",
    "<!-- Any name the booth would get wrong, spelled the way it sounds.",
    "     For example:  Bourgeois = BOOR-zhwah -->",
    "",
  ];

  const body = [...head, ...blocks, ...tail].join(LF);
  writeFileSync(OUT, body + LF + STAMP + fingerprint(body) + " -->" + LF);
  console.log("wrote " + OUT + " with " + order.length + " managers, in draft order");
}
