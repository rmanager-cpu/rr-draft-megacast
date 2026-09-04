# River Ranch Fantasy Draft Megacast

Three screens, one speaker, one laptop, and nobody touching anything after Launch.
`docs/ENGINE.md` explains how it works. `docs/BUILD-GUIDE.md` is the spec. `docs/SPIKE-RESULTS.md` is what the wire actually does.

## Run it

```
npm test                                   the whole suite, no network needed
npm start                                  the real draft (needs .env)
npm run replay                             the recorded 8/29 draft, at real speed
npm run replay:fast                        the same, in about twenty seconds
npm run replay:step                        one pick at a time, for building things
npm run synth                              an invented 12-team, 16-round draft
npm run soak                               two hours, both TVs, unattended
npm run probe -- <leagueId>                can we read that league? (safe on the real one)
```

Then open, on the show computer:

| | |
|---|---|
| `/board` | TV 1 — the live draft board |
| `/studio` | TV 2 — the pick reveal. **Click it once** to arm audio |
| `/launch` | the preflight and the one button |
| `/status` | counters, warnings, forced reconnect, emergency pick |
| `/curate` | the highlight catalogue |

Everything binds to `127.0.0.1`. The TVs are Chrome windows on this laptop, not devices on
the venue network, so the venue Wi-Fi dropping cannot touch them.

## Before draft night

1. **`.env`** — copy `.env.example`, fill in the real league id and fresh ESPN cookies.
   Add `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` if the booth is to use real voices;
   without them it speaks written lines through the laptop's own voice.
2. **`node scripts/league-info.mjs`** — the commissioner list straight from ESPN: draft
   type, date, seconds per pick, rounds, keepers, pick order, team-to-manager table, and
   whether the room hands out a token yet.
3. **`node scripts/prefetch-headshots.mjs --top 400`** — puts the images on disk so the
   studio works with the cable out.
4. **`/curate`** — work down the list in draft order. Anyone without a clip gets the
   animated card, which is the design, not a failure. Press *Check every clip* when done.
5. **`data/show.config.json`** — the knobs: recap rounds, how many opinions, pick audio,
   interjection caps, reveal timings. Edit it directly; it is read at boot and frozen at Launch.
6. **`data/lore.md`** and **`data/bible.md`** — what the booth knows about the twelve
   managers, and how the two broadcasters behave. The booth is only as good as these.

## Draft night

**Sixty minutes before.** Power, dock, Ethernet. Both TVs at 1080p on the extended desktop,
one full-screen Chrome window each. Click the studio window once so Chrome will let it make
sound. Open `/launch`.

**Fifteen minutes before.** Every check green, then press Launch once. The laptop stays
powered, awake, and untouched.

**During.** Draft in ESPN as normal. If something looks wrong, wait twenty seconds. The
board is truth. `/status` has a forced reconnect and an emergency by-hand pick, and neither
should ever be needed.

**After.** Leave the board up. Next day: keep the logs, rotate the cookies.

## When something goes wrong

| what you see | what is happening |
|---|---|
| amber bar on the board | ESPN link is down. Picks fill in when it returns; the board keeps what it knows |
| red bar on the board | the server is unreachable from that TV. It keeps the last state and retries |
| `recovering` in a cell | a pick was missed. The next reconnect fills it in with the right number |
| studio trails the board | by design, up to about fifteen seconds. It compresses and never skips a pick |
| no highlight | that player has no clip. The card is the fallback and it is intended |
| cookies expired on `/status` | paste fresh ones into `.env`, then press the reconnect button |

## Layout

```
server/    draftwire, initdecode, reconcile, state, reveal, audio, booth, highlights, http, sse
web/       board, studio, launch, status, curate - plain HTML, no build step
data/      show.config.json, lore.md, bible.md, highlights.json (caches are gitignored)
test/      node --test, no network, driven by the real 8/29 capture
scripts/   league-info, prefetch-headshots, soak, verify-board, preflight-rehearsal
```

## Spike

The original pick-source spike is finished and its findings are in `docs/SPIKE-RESULTS.md`.
`npm run spike:poll` and `npm run spike:room` are still there if the wire ever needs
re-examining. **Never paste `spike/out/ws-frames.log` anywhere:** the client half of that
capture carries session tokens.
