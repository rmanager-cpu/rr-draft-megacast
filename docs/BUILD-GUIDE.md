# River Ranch Megacast — Build Guide

v1 · Aug 27, 2026 · Draft night **Tue Sep 8** · 12 days

**The show.** One HP laptop, three screens, one speaker. Laptop = command center (ESPN draft room + launch page). TV 1 = live board. TV 2 = reveal: sting, card, highlight. Speaker = a two-voice AI booth — quiet during picks, talking at round boundaries, plus triggered interjections and pre-written bits. Press Launch once. Nobody operates anything after that.

## Decisions

| | |
|---|---|
| Pick source | A Node WebSocket client on ESPN's draft feed (`fantasydraft.espn.com`, token from `draftSecurity`). Playwright-driven draft room as fallback. The v3 endpoint is post-draft only — spike 8/29: zero live picks through 78 picks. Details: `docs/SPIKE-RESULTS.md`. |
| Runtime | One local Node process. SSE to two Chrome windows. State in memory + JSON. No Supabase, no Vercel, no OptiSigns. |
| APIs | Claude Opus 5 (writer + checker, bible cached). ElevenLabs (two voices). |
| Displays | Laptop screen + 2 TVs over USB-C, at 1080p. |
| Audio | Wired speaker off the laptop. Sonos Line-In only if it already exists. |
| Highlights | Official YouTube embeds, curated start second, 8s ceiling with per-player override, compresses under load. The card fallback is the design. |
| Facts | Packet-only. Number / name / trigger-word checks, a checker call, a deterministic fallback line. |
| Operator | Zero after Launch. A manual-pick field exists for emergencies only. |

## The room

- **Open** before round 1.
- **Picks:** sting + 2s name call. The board updates instantly. TV 2 reveal runs 18s; ~8s when a pick is waiting; cards-only at queue ≥ 3. TV 2 can trail the board 10-15s in a hot streak. It never skips a pick.
- **Recaps:** after R1, after R2, then every even round; final on COMPLETE. 60-120s: opinions on the 4 / 4 / 6-8 most interesting picks, one-line rundown of the rest, runs noted. Never interrupted.
- **Interjections:** triggered — steal, reach, run, K/DST early, per-manager rules. Live, perishable: dropped if late, capped per round.
- **Bits:** pre-written, pre-rendered inside jokes when a manager comes on the clock. If they pick first, it plays after their reveal.

## Architecture

```
HP laptop — one Node process
  watcher/     Playwright → ESPN draft room → picks
  reconcile/   order, dedupe, commit PICK_COMMITTED (season:league:pick)
  state/       memory + state.json · GET /api/state for reload recovery
  reveal/      queue + compression → /studio over SSE
  audio/       ONE channel · OPEN · NAME · INTERJECT · BIT · RECAP · FINAL
  booth/       packet → writer → checks → checker → TTS → cache
  highlights/  catalog · /curate · search (yt-dlp) · preflight
  web/         /board /studio /launch /status /curate /voices
data/
  show.config.json   schedule, knobs, triggers, bits    ← you edit
  lore.md            12 managers, jokes, leans           ← you write
  bible.md           personas, rules, examples           ← Claude, from you
  players.json       ~200: ADP, 2025 line, team, rookie flag, note
  highlights.json    playerId → videoId, start, ceiling, verifiedAt
  audio/bits/        pre-rendered mp3s
.env                 cookies + API keys — never committed
```

## Rules

- **Reveal.** Clip length is a ceiling. One pick waiting → clip cut at 4s, dwell skipped. Every pick gets its card.
- **Audio.** One channel. Never overlap; never interrupt a recap. Writer, checker, or TTS late → deterministic line or silence. Visuals never wait on audio.
- **Recovery.** Draft-room page dies → relaunch, re-login, reconcile. TV reload → /api/state. More than 3 picks missed → fast-forward, reveal the newest.
- **Launch gate.** Disabled until: draft room readable, both TVs on the same version, speaker plays the test line, highlight preflight done.
- **Fiction.** Numbers must be in the packet. Names on the whitelist. Injury / trade / suspend / cut banned unless the note says so. Checker call before speech. Rookies and team changes flagged. You read every mock line.

## Timeline

| | Build | You | Exit test |
|---|---|---|---|
| **Thu 27** | Spike harness — done | Run the spike. Order the dock. | `poll.log` verdict |
| **Fri 28 – Sun 30** | Watcher, reconciler, state, server, /board, /studio with cards, /launch, recovery. Highlight search, /curate, preflight. | `lore.md`. Start curating Sunday. | Full mock with cards, untouched |
| **Mon 31 – Wed 2** | Config, audio scheduler, name calls, writer + checks, TTS, recaps, interjections, bits, /voices. Draft player notes. | Pick voices. Write bits. Curate. | Mock with audio; you read every line |
| **Thu 3 – Fri 4** | YouTube in the reveal, compression, preflight. Hardening: reload, Wi-Fi drop, 2h soak. | Skim notes. Finish curation. Bits final. | Bad clip → card in < 2s; soak passes |
| **Sat 5 – Mon 7** | Fixes only. Freeze Sunday. | In-room mock. | Full mock in the room, untouched |
| **Tue 8** | | Draft. | |

If Labor Day weekend is service, the in-room mock is Thursday Sep 3 night.

## Ship order

1. Pick source → board → cards → name call. *The show works.*
2. Recaps. *The booth exists.*
3. Highlights, as many as curated.
4. Interjections and bits.
5. Open, final recap, sponsor reads.

## From you

- **Tonight:** the spike.
- **This week:** USB-C → HDMI adapter if the HP has its own HDMI port, else a DisplayLink dual-HDMI dock with Ethernet. Note which HDMI input on each TV. Pick the speaker.
- `lore.md` by **Sun 30** · voices by **Wed 2** · bits, curation (R1-5 + sleepers), notes skim by **Fri 4** · room mock by **Mon 7**.
- ESPN: add the watcher account as co-manager on **your** team; refresh cookies **Mon 7**.

## From the commissioner

- **League ID**, and that it's an ESPN league with all 12 teams in for 2026.
- **Draft locked:** date, start time, snake, number of rounds, seconds per pick. No changes after **Sat Sep 5**.
- **Draft order** and the date it goes final. Bits key on manager × round.
- **Keepers?** If yes, which picks are pre-filled.
- **Team ↔ manager list** as ESPN has it today.
- Anything to be said in the **open** — house rules, payout, sponsor reads — as text.
- **Pronunciations** for anyone the booth will get wrong.

## Draft night

- **60 min before.** Power, dock, Ethernet. TVs 1080p, extended desktop, one full-screen Chrome each. /launch registers displays, plays the test line, preflights the catalog, opens the draft room.
- **15 min before.** All green → Launch once. Laptop stays powered, awake, untouched.
- **During.** Draft in ESPN. Something looks wrong? Wait 20 seconds. The board is truth.
- **After.** Final recap. Leave the board up. Next day: logs, rotate cookies.

**Done:** twelve people draft in ESPN, nobody touches the laptop, the board is never wrong, every pick reveals, the booth opens, recaps, closes — and never says anything false.
