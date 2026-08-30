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
- Pending: whether picks appear after `drafted: true` (needed for post-draft reconciliation).

## Test B — what feeds the draft room? **A plain-text WebSocket. Success.**

Room URL: `https://fantasy.espn.com/football/draft?leagueId=<L>&seasonId=2026&teamId=<T>&memberId=<SWID>`

Before joining, the page calls (with cookies)
`GET /apis/v3/games/ffl/seasons/2026/segments/0/leagues/<L>/teams/<T>/draftSecurity` → token,
then opens
`wss://fantasydraft.espn.com/game-1/league-<L>/JOIN?1=1&2=<L>&3=<T>&4=<SWID>&5=<token>&6=false&7=false&8=KONA&nocache=<n>`

Frames seen (server → client unless noted):

| Frame | Meaning |
|---|---|
| `INIT <base64>` | full room state at join (binary; not yet decoded — the room's picks-so-far live here) |
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
- To verify next mock: a bare Node WS client can join with the token (no page), and what the
  wire sends at draft end.
