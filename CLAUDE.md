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
