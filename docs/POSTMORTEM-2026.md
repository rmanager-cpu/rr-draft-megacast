# River Ranch Megacast — 2026 post-mortem

Draft night: Tue Sep 8, 2026. Written Sep 16, from the owner's debrief and the commit record.

**It worked.** Twelve people drafted, the board was right, picks revealed, the booth talked,
and nobody in the room had seen anything like it. That was the whole bet, and it paid.

It also came together about an hour before the first pick, ran on one screen instead of three,
and was nursed from a phone during the draft. All three of those are fixable, and none of them
is what most people would have guessed.

## What the record actually says

| When | What |
|---|---|
| Aug 25–29 | Scoping and the pick-source spike. The ESPN wire finding, which is the hard part. |
| **Sep 4** | **44 commits in one day.** The entire engine: wire, reconciler, state, board, studio, reveal queue, audio channel, booth, highlights, 78 tests, a two-hour soak. |
| Sep 8, 19:33–20:21 | **Eight commits, live, during the draft.** |
| Sep 9 | The finale segment, on command. |

The engine was built in a day and it held. Nothing on draft night was an engine bug.

## The eight draft-night commits

Every one was content, not code: only the demon interjects, recap every round with five picks,
per-manager leans, and four specific takes on specific players as they were drafted.

That is the real finding. **The show's voice was being written live, and the config is read at
boot and frozen at Launch.** So every one of those eight edits meant restarting the show — which
is exactly the stop-and-restart the room could see. The freeze was a deliberate correctness
decision, and it turned into the most visible flaw of the night.

It also means the instinct was right. Sitting there watching it, the thing worth changing was
never the machinery. It was what the booth said about Dave.

## What shipped against what was planned

| Planned | Shipped |
|---|---|
| Three screens | **One screen and a speaker.** The board was cut day-of for looks, not for lack of code — `web/board.*` works and is tested. |
| Zero operator after Launch | **Operator on a phone**, eight times, each one a visible restart. |
| Curated highlights, full frame | Played, but **did not fill the TV frame**. |
| Two-voice booth, scheduled recaps | Talked. **Timing collisions** the owner heard and the room probably didn't. |
| Player cards as the designed fallback | Rendered, **looked unfinished**. |
| `lore.md`, player notes, bible | **Thin**, and being written during the draft. |

## The eight things for 2027

Ordered by show bought per hour of work.

1. **Make the voice editable live.** Hot-reload `show.config.json`, `bible.md` and `lore.md`
   while the show runs, and give the owner a phone-reachable page for exactly the knobs he
   reached for: leans, interjection policy, recap length, and a one-off line about the pick
   that just happened. Keep the pick pipeline frozen at Launch — that part was right. This
   single change converts the night's most visible failure into a feature, and the evidence
   for what to expose is the eight commits above.

2. **Make it portable.** One case you carry: a machine that boots into the show, its own
   network path with a hotspot fallback, HDMI to whatever TV is in the room, its own audio
   out. No dependency on one laptop in one office.

3. **Fix the frame.** Clips must fill a 1080p TV — scale-to-cover with crop, per-clip framing
   saved in `/curate`, and a preflight that renders at real output resolution instead of
   trusting the embed. Small fix, large effect on how finished the whole thing feels.

4. **Test audio timing.** One channel, strict precedence, replayed against the recorded pick
   stream so collisions surface in `npm run replay` and not in the room.

5. **Design the player card.** It is the most-shown asset in the show, since everyone past the
   curated list gets one. Typography, headshot treatment, team color, a little motion.

6. **Bring the board back.** It was cut for how it looked, so this is a design pass on working
   code, not a rebuild. Between picks it is what the room stares at.

7. **Write the context early.** Lore, manager history, rivalries, last season's results, player
   notes. Owner homework, and it cannot be done on draft day — draft day is the proof. It is
   also the biggest single lever on whether the booth is funny or generic.

8. **Make it theatrical.** Open, sign-off, sponsor reads, stings, running bits, a rundown with
   real structure. Never reached in 2026, and the whole point of 2027.

## The structural lesson

2026 spent its budget proving it works. That is done, it is on `master`, and it has tests. 2027
starts from working code, so the budget goes to the show — but only if the engine is green in
the spring, replayed against the 2026 capture, and left alone in August.

## Keep

- The ESPN wire finding in `docs/SPIKE-RESULTS.md`, including the decoded `INIT` blob. Hardest
  part of the project, fully solved.
- Silent picks, recaps at round boundaries. The room talks during picks; the booth talking over
  them was always going to be wrong.
- "The card fallback is the design." Held up.
- Freezing the pick pipeline at Launch. Right call. Just not for the words.
