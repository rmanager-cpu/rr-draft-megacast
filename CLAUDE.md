# River Ranch Fantasy Draft Megacast

Three-screen fantasy-draft broadcast for a private 12-team ESPN league: command-center
computer (ESPN + launch/status), TV 1 draft board, TV 2 pick reveal + highlight, one
speaker with AI announcer. Spec: `docs/River_Ranch_Fantasy_Draft_Megacast_Three_Screen_Build.pdf`
(drop it in `docs/`). This file is the handoff from the scoping conversation on 2026-08-25.

## Hard facts

- **Draft night: Tuesday September 8, 2026** (day after Labor Day). 14 days from scoping.
- **Non-negotiable:** highlights and AI commentary. Zero operator after Launch.
- **Highlight policy (owner-approved):** catalog built in ADP order; owner scrubs as far
  as time allows (~first 60). Players beyond that get the animated player card — that is
  the design, not a failure. Headshots: `https://a.espncdn.com/i/headshots/nfl/players/full/{espnPlayerId}.png`
- Standard pre-season redraft: 2025-season clips, August ADP ranks.

## The finding that reshapes the spec

The spec polls `?view=mDraftDetail` every 2s during the draft. The espn-api maintainer
(cwendt94, Aug 2024, https://github.com/cwendt94/espn-api/issues/558) says ESPN runs live
drafts on a separate API and the league endpoint only reflects picks **after the draft
completes** — he tried and failed. People who needed live picks read the draft-room page.

Pick-source plan, in order:
- **A.** Test v3 live during a throwaway-league draft (owner + 11 autopick). One hour. Do first.
- **B (proven).** The show computer keeps the ESPN draft room open under Playwright control,
  logged in as a league-member account (co-manager on the commissioner's team). Server reads
  the pick list (DOM mutations or WebSocket frames) and commits picks. Server owns the
  browser, so recovery is automatic: page dies -> relaunch, re-login, reconcile.
- The v3 endpoint works after completion -> use it for final-board / final-recap reconciliation.
- **C (emergency only).** Manual "enter pick" field on /launch. Build it; never plan to use it.
- Spike must also prove a spectator page survives a 2-hour draft without an idle prompt.

## Architecture decisions (differ from the spec)

- **One local process on the show computer.** In-memory state + JSON on disk, SSE to the TV
  tabs. No Supabase, no Vercel: the TVs are three feet from the server; an internet hiccup
  must not freeze them. ESPN cookies live in a local `.env`, never in a browser.
- No OptiSigns.
- Speaker: wired off the show computer unless a line-in Sonos (Five/Port/Amp/Era) already
  exists. Owner to confirm.
- Commentary: pick call + bounded LLM one-liner, 4s deterministic fallback, never-interrupt
  queue with catch-up read, return-to-one recaps. Show bible leans: Dave Hoffman -> skeptical
  (football decision only); Turbo -> impressed (only when the draft state supports it).

## Commentary model (owner 2026-08-26) — replaces the spec per-pick calls

Schedule: **open** before R1 → **recap after R1** → **recap after R2** → recap **every two
rounds** after that (4, 6, 8, ... = snake return-to-one) → **final recap** on COMPLETE.
During picks: no commentary — sting + optional 2s name call; highlight on TV 2. People talk.

- **Recaps** are the show: 60-120s, opinions on the N most interesting picks (4 for R1/R2,
  6-8 for two-round recaps), the rest as a one-line rundown, position runs noted. Never interrupted;
  a pick landing mid-recap reveals on the TVs with the sting suppressed, covered next recap.
- **Reactive interjections** on triggered picks (steal/reach by ADP gap, position run, K/DST
  early, manager-specific rules e.g. Dave reaching). Generated live, so PERISHABLE: drop if not
  ready within ~10s, never queue. Capped per round + cooldown.
- **Scheduled bits** when a manager comes on the clock in a given round (inside jokes). Owner
  writes them (or approves Claude drafts from lore); pre-rendered to audio BEFORE draft night —
  zero latency, zero fiction risk, auditioned in advance.
- **Show config file** (owner edits directly; not hidden behind UI): recapAfterRounds[],
  opinionsPerRecap, pickAudio (sting | sting+name | call), interjections {maxPerRound,
  cooldownSeconds, dropIfLaterThanSeconds, triggers[]}, bits[].
- Interest score per pick: value gap (ADP vs pick), position run, roster oddity, first rookie /
  first TE, Dave/Turbo leans as a thumb on the scale.
- Two-voice booth (play-by-play + color), ElevenLabs voices; writer = Claude Opus 5 with the
  bible cached (1h TTL). Facts packet-only: number/name/trigger-word checks + a checker call
  before anything is spoken; deterministic fallback. Rookies flagged as unknown to the model.
- Knowledge on disk = three files: lore (owner, ~2-3k words), player notes (Claude drafts from
  ESPN data + web pass, owner skims), show config (shared). Plus the bible (Claude, from the
  owner's direction on the two broadcasters).
- Owner note (2026-08-26): can and will touch config/code; do not route around him with UI.

## 14-day plan

| Days | Build | Done when |
|---|---|---|
| Aug 25-26 | Draft-room watcher + spike harness; owner runs throwaway draft | Picks logged <5s untouched; spectator page survives |
| Aug 27-29 | Local server, reconciler + tests, state machine, board, studio w/ cards, launch/status, reload + Wi-Fi-drop recovery; highlight search script (yt-dlp, official channels, ADP order) | Full mock end-to-end on one monitor |
| Aug 30-Sep 1 | Audio scheduler, pick calls, TTS, fallback, recaps, show bible; curation tool (player -> candidate clips -> scrub start/end -> test-embed -> save) | 25 mock picks in order; rounds 1-5 curated |
| Sep 2-4 | YouTube IFrame player, 1.8s ready timeout, fallback ladder, automated embed preflight; first 2h unattended soak | Bad clip -> clean card <2s; soak passes |
| Sep 5-7 | In-room rehearsal on real TVs/speaker; freeze Sunday; Monday preflight only | One full mock in the room, untouched after Launch |
| Sep 8 | Draft | |

Ship order (a slip costs the least important thing): 1 pick source + board + card reveal +
deterministic TTS call -> 2 AI one-liner -> 3 highlights in ADP order -> 4 recaps ->
5 open/sign-off/sponsor spots (only if copy exists by Sep 1).

## Spike harness

`npm run spike:poll` (Test A: v3 live polling) and `npm run spike:room` (Test B: draft-room
recorder). Run sheet in `README.md`. Results land in `spike/out/` (gitignored).

## Open items for the owner

- Is Labor Day weekend a service weekend? If so, the focused build day is this week and the
  in-room mock is Mon night / Tue afternoon.
- Line-in Sonos in the building? Otherwise wired speaker.
- Dual-HDMI dock + USB audio adapter on hand? Order by Aug 27 if not.
- Create the throwaway 12-team league (draft scheduled for the spike) and, if using a separate
  integration account, add it as co-manager on the commissioner's team now.
