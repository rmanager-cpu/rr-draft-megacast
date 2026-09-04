# Phase 0 spike — results (Sat Aug 29, 2026, 8:40–9:20 PM PT)

Ran on the desktop, not the laptop. Throwaway league `120596440` could not draft (ESPN:
"league isn't full" — it will not schedule a draft with unowned teams), so both tests ran
against ESPN **mock drafts**, which are ordinary leagues (`leagueSubType: "MOCKDRAFT_LOBBY"`)
readable through the same API with the participant's cookies. First mock (`1979635407`) was an
auction by accident; second (`1814994619`) a 10-team PPR snake with real humans, 30s clock.

## Test A — does the v3 league endpoint show live picks? **No.**

- `draftDetail.picks` is pre-populated with every slot (160) at `playerId: -1` before the draft.
- `inProgress` flips to `true` ~90s before the listed start (room opens). Through **78 picks**
  of a live draft, `made` stayed **0/160**. `view=mRoster` also showed 0 roster entries.
- `draftSettings.date` is hidden from anonymous reads; present with member cookies.
- Post-draft: the mock league returned **404 within two seconds** of the final pick — ESPN
  deletes mock leagues at completion — so "does v3 fill `picks` after `drafted: true`" could not
  be checked here. The espn-api community relies on it for completed drafts; verify on the real
  league the morning after, and do not make the final board depend on it.

## Draft end on the wire

Final pick `SELECTED 1 4567104 9` at 04:23:45, then `STATE 2` — the wire's draft-complete
signal. 150 `SELECTED` frames after joining mid-round-1 (160 picks total); bots picked in 1.3s.

## Test B — what feeds the draft room? **A plain-text WebSocket. Success.**

Room URL: `https://fantasy.espn.com/football/draft?leagueId=<L>&seasonId=2026&teamId=<T>&memberId=<SWID>`

Before joining, the page calls (with cookies)
`GET /apis/v3/games/ffl/seasons/2026/segments/0/leagues/<L>/teams/<T>/draftSecurity` → token,
then opens
`wss://fantasydraft.espn.com/game-1/league-<L>/JOIN?1=1&2=<L>&3=<T>&4=<SWID>&5=<cred>&6=false&7=false&8=KONA&nocache=<n>`

where `<cred>` is the composite `1:<L>:<T>:<SWID>:<token>` — the same string the room
echoes back in its `TOKEN` frame. `draftSecurity` returns only the numeric tail.

Frames seen (server → client unless noted):

| Frame | Meaning |
|---|---|
| `INIT <base64> <padding>` | full room state at join — **decoded, see below**. Two chunks: real base64, then 2048 `#` filler |
| `TOKEN <token>` · `JOINED <teamId> <SWID>` | handshake |
| `AUTODRAFT <teamId> <true/false>` | a team toggled autopick |
| `CLOCK <?> <msLeft> <teamOnClock>` | every ~5s; first field unclear (stayed 6) |
| `SELECTING <teamId> <clockMs>` | team on the clock |
| `SELECTED <teamId> <playerId> <n> [<SWID>]` | **the pick.** `n` looks like a lineup slot; SWID absent for bot/unowned teams |
| `AUTOSUGGEST <playerId>` | the room's suggested pick for *this* client |
| `BID <teamId> <playerId> <amount> <?> <msLeft>` | auction only |
| client `PING <ms>` → `PONG <same>` | keepalive |

Picks arrive the instant they happen; `SELECTING→SELECTED` gap is the human's think time
(1.3s = autopick). The page also opens a `bamgrid.com` DSS websocket — telemetry, ignore.
**Never log client→server frames**: they carry the Disney access token.

## The INIT blob — decoded (Sep 4)

The room snapshot is a plain array of fixed 45-byte records, one per pick slot, laid out
in draft order. Each record: `int32BE` tag `3`, leagueId, **teamId**, **overall pick
number** (1..N, sequential), **playerId** (`-1` when the pick has not been made), lineup
slot. `server/initdecode.mjs` discovers the offset and stride rather than hardcoding them,
checks that every team owns exactly one pick per round, and fails closed on any doubt.

Two things had hidden it. The frame is two whitespace-separated chunks and the second is
2048 literal `#` characters; stripping whitespace and decoding the whole thing works only
because Node's base64 decoder discards invalid characters silently. And the earlier probe
searched for the first playerIds seen on the wire — exactly the picks INIT cannot contain,
because they had not happened yet. What it contains is everything *before* the join.

Verified on both captured blobs. The auction league decodes to 160 records, nothing sold,
with a nomination order that repeats rather than reverses. The snake mock decodes to 10
teams × 16 rounds with the teamId column snaking `1..10, 10..1, 1..10`; its ten filled
records are round one, they share no player with the 150 `SELECTED` frames that followed,
and 10 + 150 = 160.

**What this buys.** Mid-draft recovery, exactly rather than by inference: every reconnect
delivers a fresh INIT, so any gap heals with correct pick numbers. The authoritative draft
order, including keepers and any custom order, without depending on `pickOrder` being set.
And the round count, straight from the record total.

Caveat: verified on two blobs from one night, both 10-team. Never hardcode the offset.

## Player table

`GET /apis/v3/games/ffl/seasons/2026/players?scoringPeriodId=0&view=kona_player_info` with header
`x-fantasy-filter: {"players":{"limit":1500,"sortPercOwned":{"sortPriority":1,"sortAsc":false}}}`
→ 11,617 players (`id`, `fullName`, `defaultPositionId`, `proTeamId`), anonymous OK, 1.7s.
(`view=players_wl` is paged to 50 — don't use it.) `scripts/spike-replay.mjs` resolves the
night's frames with it: 78 picks, one Map lookup each.

## What this means for the build

- **Pick source = a Node WebSocket client on `fantasydraft.espn.com`**, joined with the league
  member's cookies → `draftSecurity` token. No browser in the loop. Playwright-driven draft room
  stays as the fallback (proven tonight). The on-screen list is never read — it is easy to
  misread by a row; the wire is exact.
- Team names from `view=mTeam`; player table cached the day before; rookies flagged from it.
- Rehearsal venue: the mock lobby (10-team snake, humans, 30s clock), not a throwaway league.
- Reconnect is the recovery mechanism. A fresh INIT on every join heals whatever was missed,
  so the reconciler never has to guess its position in the snake.
- To verify next mock: a bare Node WS client can join with the token (no page). Node's global
  `WebSocket` sends no `Origin` header and takes no custom headers; if ESPN checks it, the
  fallback is the `ws` package, not a browser in the hot path.
