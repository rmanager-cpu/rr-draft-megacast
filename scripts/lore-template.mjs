// Lay out data/lore.md with this league's twelve managers, in draft order, so
// the file is fill-in rather than blank page.
//   npm run lore
//
// It refuses to overwrite a lore file that has real writing in it. Losing that
// would be the worst thing this repository could do to its owner.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchLeague } from "../server/league.mjs";
import { loadEnv } from "./env.mjs";

const LF = String.fromCharCode(10);
const OUT = "data/lore.md";
const env = loadEnv();
const leagueId = process.argv.find((a) => /^\d+$/.test(a)) || env.ESPN_LEAGUE_ID;

if (existsSync(OUT)) {
  const existing = readFileSync(OUT, "utf8");
  // Anything that is not a heading, a comment or blank counts as writing.
  const written = existing
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("<!--") && !l.trim().startsWith("-") && !l.trim().startsWith("*") && !l.trim().startsWith("|"))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (written > 60) {
    console.error("data/lore.md already has writing in it (" + written + " words). Not touching it.");
    console.error("Move it aside first if you really want a fresh template.");
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
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

  writeFileSync(OUT, [...head, ...blocks, ...tail].join(LF));
  console.log("wrote " + OUT + " with " + order.length + " managers, in draft order");
}
