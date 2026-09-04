# How the engine works

One Node process on the show computer. It reads the draft, keeps the board, and drives
three windows and a speaker. Nothing runs in the cloud, nothing is installed on the TVs,
and the whole thing is a couple of thousand lines you can read.

Everything below flows one way. Picks come in on the left, pixels and sound go out on the
right, and no stage ever waits on a stage downstream of it.

```
ESPN draft room --> the wire --> reconciler --> state --> board (TV 1)
                                     |               \--> reveal queue --> studio (TV 2)
                                     \-------------------> booth --> speaker
```

## 1. Where picks come from

The spike settled this. ESPN's ordinary league API is blind during a live draft: through
78 picks of a real one it reported zero. What feeds the draft room is a plain-text
WebSocket on fantasydraft.espn.com. You get in by asking a league endpoint for a room
token with your own cookies, then opening a socket with it.

The room speaks in short lines. The ones that matter:

| frame | meaning |
|---|---|
| `INIT <data>` | the whole room, sent the moment you join |
| `SELECTING <team> <ms>` | that team is on the clock |
| `SELECTED <team> <player> <slot>` | **a pick** |
| `CLOCK <?> <ms> <team>` | a tick, about every five seconds |
| `STATE 2` | the draft is over |

No browser is involved. The show talks to the room the same way the room's own page does,
which is why nothing is ever misread off a screen.

## 2. The room snapshot, which is the important part

INIT looked opaque and the first attempt to read it failed. It is not opaque. It is a
plain list, one entry per pick slot, in draft order, each entry saying: this is pick
number N, it belongs to team T, and the player taken was P, or nothing yet.

Two things had hidden it. The frame arrives in two chunks and the second is padding,
which quietly corrupted the decode. And the first attempt searched for the picks we had
just watched arrive, which are exactly the ones the snapshot cannot contain. What it
contains is everything from before you joined.

Reading it changes three things, all for the better.

- The draft order comes off the wire, per pick, including keepers and any custom order.
  League settings become a cross-check rather than something we depend on.
- Joining late is fine. Everything already picked arrives with its correct number.
- Reconnecting is the recovery mechanism. Every reconnect brings a fresh snapshot, so any
  hole heals with exact pick numbers instead of guesswork.

The decoder works out the layout each time and validates it rather than trusting fixed
offsets. If anything looks wrong it says so and refuses, because a wrong board is worse
than a board that admits it does not know yet.

## 3. Turning frames into a board

The wire says who took whom. It never says which pick number that was. The reconciler
supplies the number, and handles the three things that go wrong.

**Duplicates.** Every reconnect replays frames you already have. Caught by player, since
a player is drafted exactly once, which is a stronger test than comparing frame text.

**Gaps.** If a pick arrives for a team that is not on the clock, we missed frames. That
pick goes to that team's own slot, and the slots we skipped are recorded as gaps with a
reconnect requested. The board shows those cells as recovering, rather than blank or,
much worse, giving a player to the wrong team. The next snapshot fills them in.

**Corrections.** If the room's snapshot disagrees with something already on the board,
the room wins and the board patches that one cell. That is what makes "the board is never
wrong" literally true rather than aspirational.

Every pick is written to an append-only file the instant it commits, and the whole state
is saved atomically. Kill the process at pick 90 and it comes back with all ninety.

## 4. What the TVs see

Both TVs are Chrome windows on this laptop talking to 127.0.0.1. The venue Wi-Fi dropping
cannot touch them, and nothing is listening on a network anyone else can reach.

They receive a stream of events. The last thousand are kept, so a TV that reloads replays
exactly what it missed instead of refetching the world. Clock ticks are marked disposable
and get dropped under pressure. Picks never are. Each window subscribes only to what it
draws.

The board builds its grid once and then patches one cell at a time. It never clears
itself. If the connection drops it says so in a bar across the top and keeps every pick it
already has, because a board that blanks itself in front of twelve people is the worst
thing this program could do.

## 5. The reveal, and what happens in a hot streak

TV 2 shows one pick at a time. The server owns the queue and the clock. The browser plays
what it is told and holds until the deadline it was given, which is why a TV can be
reloaded mid-reveal and pick the same card back up with the right time remaining.

When picks stack up, the reveal compresses.

| picks waiting | reveal | length |
|---|---|---|
| none | full: sting, card, highlight | 18s |
| one or two | short | 8s |
| three or more | card only | 4s |

A reveal already on screen is shortened, never restarted. Its deadline can only move
closer, never further away, and never below a floor once the card has landed. Nothing is
ever dropped: a burst of twelve reveals twelve, in order. TV 2 is allowed to trail the
board by ten or fifteen seconds. It is not allowed to skip a pick.

Catching up after a disconnection is deliberately different. Revealing thirty missed picks
one at a time would put the studio minutes behind the room, which is worse than not
showing them at all, so it shows a strip naming them and then the newest pick.

The highlight is the first thing sacrificed and the card is the last. A clip only becomes
visible once the player reports it is genuinely playing, and it has under two seconds to
do that. The card is already on screen underneath the whole time, so a clip that stalls,
or was pulled from YouTube last week, costs nothing.

## 6. The speaker

One channel. Nothing overlaps, and a recap is never interrupted. A pick landing mid-recap
is suppressed rather than queued behind it: the reveal still happens, and the next recap
covers the pick.

Reactions are perishable on purpose. If one is not ready within about ten seconds it is
thrown away, because reacting to a pick nobody is looking at any more is worse than
saying nothing. There is a cap per round and a cooldown, so the booth cannot end up
talking over the entire draft.

Every line carries a deadline. If the browser never reports that it finished, the channel
frees itself anyway. A wedged speaker would be silent for the rest of the night.

### What the booth is allowed to say

This is the part with teeth, and it is enforced in code rather than by instruction.

The booth may say only what is in the packet it was handed. A number that was not in the
packet is refused. A name that was not in the packet is refused. Anything about an injury,
a trade, a suspension, a release, a holdout or a legal matter is refused outright, unless
that player's own note says it. The notes come from ESPN's own season write-ups, so they
are facts rather than inventions, and they are also the boundary: what the note states,
the booth may repeat, and nothing else.

Every line has a written version that needs no model, no network and no key. If the writer
is slow, absent, or says something that fails the checks, the written line goes out
instead and the show does not notice. Losing the booth costs colour, never continuity.

## 7. When things go wrong

| what happens | what the show does |
|---|---|
| ESPN link drops | reconnects with a fresh token, backing off. The board keeps everything and shows an amber bar with the elapsed time |
| the socket half-opens | clock ticks stop arriving. After 45 seconds of silence the connection is torn down and rebuilt. A dropped Wi-Fi link often never fires a close event, so waiting for one is how a show dies quietly |
| picks were missed | the next snapshot fills them in with the right numbers |
| a TV is reloaded | it replays what it missed, or is handed the whole state |
| the process dies | it restarts with every pick it had, and treats the replayed ones as duplicates |
| cookies expire | said plainly on the status page, with a button to reload them |
| a clip is dead | the card, which was already on screen |
| the writer is slow | the written line |
| every AI piece fails | the board and the reveal carry on exactly as before |

## 8. The files you will actually touch

- `data/show.config.json` - recap rounds, how many opinions, pick audio, interjection caps,
  reveal timings. Read at boot and frozen when you press Launch.
- `data/lore.md` - the twelve managers. The booth is only as good as this.
- `data/bible.md` - how the two voices behave. A draft to rewrite.
- `data/player-notes.json` - generated from ESPN, worth a skim, because anything in there
  the booth may say.
- `/curate` - the highlight catalogue, worked down in draft order.

Everything else is `server/`, one small file per job, and `web/`, which is plain HTML with
no build step because you should be able to open it and read it.

## 9. Testing it without a draft

Live drafts are not available on demand, so every source emits the same frames and the
show cannot tell them apart.

- `npm run replay` plays back a real recorded draft at real speed.
- `npm run replay:step` advances one pick at a time.
- `npm run synth` invents a full twelve-team draft, deterministically, so a failure can be
  reproduced exactly.
- `npm run soak` runs one unattended for two hours with both TVs open and prints a single
  pass or fail.
- `npm run probe -- <leagueId>` asks whether a given league's draft room can be read. The
  plain form touches nothing and is safe to run against the real league.
