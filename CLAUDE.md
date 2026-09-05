# River Ranch Fantasy Draft Megacast

**Draft night: Tuesday September 8, 2026.** One HP laptop, three screens, one speaker,
nobody touching anything after Launch.

Read `docs/ENGINE.md` first: it explains how the whole thing works. `README.md` is the
run sheet. `docs/BUILD-GUIDE.md` is the original spec. `docs/SPIKE-RESULTS.md` is what
the ESPN wire actually does.

## State as of Sep 4

The show is built and runs end to end. Branch: `build/show-server`.

**Working and verified:**

- Pick source. A Node WebSocket client on ESPN's draft feed, no browser. The room's
  `INIT` snapshot is decoded, which is what makes recovery exact rather than guesswork.
- Reconciler: pick numbers, duplicates, gaps, corrections. Replaying the real 8/29
  capture rebuilds all 160 picks with no gaps and nobody drafted twice.
- `/board`, `/studio`, `/launch`, `/status`, `/curate`. A headless browser check
  confirms every board cell matches the server.
- Reveal queue with the compression ladder, 18s / 8s / 4s, never skipping a pick.
- Audio channel, booth with written fallbacks, the fiction guard, recap schedule,
  interjections, bits, the open.
- Highlight catalogue, curation page, preflight, and the fallback ladder to the card.
- Restart mid-draft, a simulated dropout, and a dead clip are all covered by scripts.
- 78 tests, none of which need a network.

**Not yet done, and all of it needs the owner:**

- The live wire has never been run against a real ESPN draft room. This is the one
  unverified link. ESPN allows a practice draft inside the home league; that is the
  rehearsal to do. `npm run probe -- <leagueId>` is safe to run against the real league
  at any time and answers whether the room will issue a token.
- `.env` still points at a deleted mock league. The real league id is needed.
- No `ANTHROPIC_API_KEY` or `ELEVENLABS_API_KEY`, so the booth speaks written lines
  through the laptop's own voice.
- `data/lore.md` is still a template. The booth is only as good as that file.
- No highlight clips curated yet.
- The in-room rehearsal on the real TVs and speaker.

## BEFORE THE DRAFT: the show must be signed in as Mega Cast

On the night the owner drafts as himself and the show sits in the room as **Mega Cast**,
the co-manager on team #2. Two different members on the same team, which is the case ESPN
is built for.

On Sep 4 the cookies were switched to the owner's own account **temporarily**, only because
a practice draft contains nothing but the account that created it, so two accounts can
never be in one and coexistence cannot be rehearsed there.

```
npm run login -- --fresh      then sign in as Rmanager@riverranchlodge.com
```

It prints which account it captured. It must say **Mega Cast**, team #2. If it says Alex
Mondschein, the show and the owner will fight over one seat in the draft room all night.
## NEXT: the dry run. Do this first.

Not yet done as of Sep 4. It answers the only two open questions in the project at
once, and everything else is downstream of both. No HDMI, no second screen, no full
screen - a browser window on whatever monitor is in front of you.

Set the machine up first: see **Moving it to another machine** in `README.md`.

**1. Put the show on its own ESPN account.**

```
npm run login -- --fresh
```

Sign in as `Rmanager@riverranchlodge.com` (Mega Cast). It confirms the account and team
back to you. It must say Mega Cast and team #2, not Alex Mondschein.

**2. Curate a few clips for players who will certainly go early.** Without this the
reveal shows a card and the run teaches nothing about YouTube.

```
npm run replay:step
```

Open `http://127.0.0.1:7788/curate` and put clips on the top five by draft position:
Gibbs, Bijan Robinson, Chase, Nacua, Jonathan Taylor. They go in the first handful of
picks of any draft. Then stop that server.

**3. Start a practice draft in ESPN.** Take the league id out of the URL. It is a
separate, temporary league with its own id, and it is deleted when it finishes.

**4. Run the show against it.**

```
npm start -- --league <practice league id>
```

**5. Open `http://127.0.0.1:7788/studio` in a browser window** and click it once so
Chrome will allow sound. That is where the card appears and the clip plays. Then draft
in your normal browser, signed in as yourself.

### What it settles

**Can Mega Cast and the owner sit in the room together.** ESPN allows one draft-room
connection per member; two on the same account evict each other, which was proven on the
9/4 practice draft. A co-manager is a different member and should be fine, but it is
unproven. If the show gets closed within seconds three times running it will say so
plainly and back off rather than spend the night evicting the drafter. If that happens,
switch to `--source room`, which reads the frames of the window you are drafting in and
cannot be evicted because it opens nothing.

**Whether a YouTube clip actually plays inside the reveal.** The card shows immediately
and the clip only appears once the real video is running, so an advert is never seen -
but an advert can still eat the window. If clips reliably fail to start, that decides the
local-files question, which is already specified below and cleared by the owner.
## The league, confirmed from ESPN on Sep 4

**Live free or die hard RR4L**, league id `36784699`. Twelve teams, full.

| | |
|---|---|
| Draft | Snake, **Tuesday Sep 8 2026, 7:00 PM PT** |
| Clock | **90 seconds** per pick |
| Rounds | 16 - QB, RB x2, WR x2, TE, D/ST, K, FLEX, seven bench, one IR |
| Keepers | none |
| Order | already set, manual |
| Owner | Alex Mondschein, team **#2 Trust The Process**, picking 9th |

Draft order by team id: 6, 3, 5, 7, 1, 8, 12, 13, 2, 11, 9, 4.

**Team ids are not 1 to 12.** They run 1-9 and 11-13, with no 10. Nothing may assume
otherwise; the order comes off the wire and the settings, never from a counter.

| Slot | Team | Manager |
|---|---|---|
| 1 | -bby not -bbers | Robert Kuebler |
| 2 | Doff | Dave Hoff |
| 3 | squawvy Cal Pal | Callie Ewing |
| 4 | Mr steel ur girl | Bailey Bourgeois |
| 5 | Handsome Rojek | Kristian Rojek |
| 6 | Rojek's Daddy | Brad Alvarez |
| 7 | Cam's Killas | Camree Tierney |
| 8 | Kerry's Top-Notch Team | Kerry Poche |
| 9 | Trust The Process | Alex Mondschein |
| 10 | Team Dansky | Alex Dansky |
| 11 | Who's the Man? | Chris Burnham |
| 12 | Mind Games | Connor Tierney |

The watcher account **Mega Cast** joined team #2 on Sep 4, alongside Alex Mondschein, so
the arrangement below is now in place and not just possible.

Co-managers are allowed and already in use: team #1 has two accounts, `therojek` and
`New - therojek`, both Kristian Rojek. That is the exact pattern the show needs, so it
is a precedent rather than a request for a favour.

`draftSecurity` already issues a token for team #2, four days out, so the room does not
have to be open for the handshake to work.

The show bible leans on "Dave Hoffman" and "Turbo". Dave Hoff is team #3, so that one
lands. Turbo is not a name in the league, but team #9 "Who's the Man?", managed by Chris
Burnham, carries the abbreviation "TURb" - almost certainly him. **Unconfirmed by the
owner.** The booth must not use a nickname for a real person on the strength of a guess,
so leave the lean off Turbo until that is a yes.
## Highlights: decided to store them locally (Sep 4, not yet built)

The owner has cleared downloading. The reason is not adverts, it is that an eight-second
reveal cannot carry a network dependency: a YouTube embed spends one to three seconds
loading, negotiating and seeking before it shows anything, every time, and varies with the
venue's connection. A local file starts on the next frame. Adverts disappearing is a side
effect. Google Drive and similar are strictly worse - still a network hop, plus throttled
hotlinks and an auth session.

Two things learned while setting this up:

- **The show machine needs `yt-dlp` and `ffmpeg`.** On Windows:
  `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg`. Restart the shell after;
  winget updates PATH but not the running one.
- **`--download-sections` does not work against YouTube.** ffmpeg makes its own range
  request without yt-dlp's session and gets a 403. Download the whole video with yt-dlp,
  then trim locally with ffmpeg, then delete the original. Peak disk is one full video.

Clips play muted over the card, so download video only - no audio stream at all.

Still to build: a fetch step, a file path in the studio alongside the existing embed path,
a download button on /curate, and a preflight that asks whether the file is on disk. Keep
the embed code: a clip with no local file should still play the old way.

The catalogue (`data/highlights.json`) travels in git. The video files do not, so the fetch
runs on whichever machine will run the show.
## The watcher account

The show needs its own ESPN account, added as a **co-manager on the owner's own team**.

ESPN allows one draft-room connection per member. Joining with the same account a
person is drafting from evicts that person, which was proven on the 9/4 practice draft:
the room decoded perfectly and then closed us within seconds. A co-manager is a
different member, which is the case ESPN is built for.

It goes on the owner's own team rather than the commissioner's for one reason. If the
limit ever turns out to be per team rather than per member, the disruption lands on the
person running the show, who is sitting at the laptop and can react, rather than on a
friend who is just trying to draft.

A practice draft is a **separate, temporary league** with its own id, and ESPN deletes it
when it finishes - 423733550 was gone within the hour. So run `npm run probe -- <id>`
to read each new one, and use `--league <id>` rather than editing the environment file.

## Decisions that still hold

- **One local process.** In-memory state plus JSON on disk, server-sent events to the two
  TV windows. Bound to loopback, so the venue Wi-Fi cannot reach the TVs. No cloud, no
  framework, no build step. The owner reads and edits this code, so keep it plain.
- **The v3 league API is blind during a live draft.** Proven: zero picks through 78. Do
  not reintroduce polling as a pick source. It is useful only after completion.
- **The on-screen draft list is never read.** The wire is exact; a screen is easy to
  misread by a row.
- **Never log what we send.** Client frames carry a Disney access token. `spike/` holds a
  capture that includes them and must not leave the machine or be pasted anywhere.
- **Highlight policy.** Catalogue in draft order, curated as far as time allows. Everyone
  past that gets the animated card. That is the design, not a failure.
- **Visuals never wait on audio.** Structurally, not by discipline: nothing in the reveal
  path can await the booth.
- **The booth may say only what is in the packet.** Numbers, names, and any claim about an
  injury, trade, suspension, release, holdout or legal matter are refused unless that
  player's own note states it. Enforced in code, not by prompt.
- **Owner note (2026-08-26): he can and will touch config and code. Do not route around
  him with a user interface.**

## Commentary model (owner, 2026-08-26)

Open before round 1, recap after rounds 1 and 2, then every second round, final on
completion. During picks: no commentary, just a sting and a short name call. People talk.

Recaps are the show: 60 to 120 seconds, opinions on the few genuinely interesting picks,
the rest as a quick rundown, position runs noted. Never interrupted. Interjections are
live and perishable, dropped if late, capped per round. Bits are pre-written and
pre-rendered, keyed to manager and round.

## Running it

```
npm run setup          make this machine ready, and say what is missing
npm test               78 tests, no network
npm run replay:fast    the real 8/29 draft in about twenty seconds
npm run replay         the same, at real speed
npm run synth          an invented twelve-team draft
npm run soak           two hours unattended, both TVs, one pass-or-fail line
npm run probe -- <id>  can we read that league's draft room? safe on the real one
npm start              the real thing
npm start -- --league <id>   point it at a practice draft
```

## Watch out for

- **Shell escaping eats regular expressions.** Several patterns in this repo lost their
  backslashes to editing and silently matched nothing, which is far worse than failing.
  Where it matters, the code is deliberately written without escape sequences and says so.
  If you edit a pattern through a shell, check the file afterwards.
- **Late binding.** The reconciler, the wire source and the league all come into existence
  after the things that use them, so several places take a getter rather than a value.
  Destructuring a getter freezes it at null; this has bitten three times.
- **A player id can be negative and still real.** Every defense is. Only exactly `-1`
  means an empty slot, and only inside the room snapshot.
