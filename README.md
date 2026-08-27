# River Ranch Fantasy Draft Megacast

See `CLAUDE.md` for the plan. This file is the spike run sheet.

## Tonight: the pick-source spike (Phase 0)

Question: can a program see ESPN picks *while* the draft is live, with nobody
touching anything? Two tests run side by side during one throwaway draft.

### 1. Throwaway league (ESPN, ~10 min)

1. fantasy.espn.com -> Create League. Name it anything. **12 teams**, defaults otherwise.
2. League settings -> Draft: **Snake**, live draft, **30 seconds per pick** (or the minimum),
   date = tonight, time = about 30 minutes from now.
3. Set your own team to autopick (Draft Room or team settings) so nobody has to click.
   The 11 unowned teams autopick on their own.
4. Copy the `leagueId` from the URL.

If ESPN refuses to schedule a draft with unowned teams, say so. Test B still works
from the mock-draft lobby, and we find another route for Test A.

### 2. `.env` (~2 min)

    copy .env.example .env

Fill `ESPN_LEAGUE_ID`. For `ESPN_SWID` / `ESPN_S2`: in Chrome (logged in to ESPN) press
F12 -> Application -> Cookies -> `https://fantasy.espn.com`. SWID keeps its `{braces}`.

### 3. Run (two terminals, ~20 min before the draft)

    npm install
    npm run spike:poll      # terminal 1. Test A: polls the v3 endpoint every 2s
    npm run spike:room      # terminal 2. Test B: opens Chrome, records the draft room

In the Chrome window that opens: log in if asked, open the **Draft Room** when the
league page offers it, then leave it alone. Let the draft run to completion. Ctrl+C both.

### 4. What to look at

Everything lands in `spike/out/`.

- `poll.log` is the verdict. If `PICK #...` lines appear while `inProgress=true`, the
  spec's polling design works. If `picks=0` until `drafted=true`, it does not, and the
  draft room is the pick source.
- `ws-frames.log` + `dom-*.txt` are what the draft room emits: the raw material for the
  zero-operator watcher either way.
- Note anything the draft room asked you (idle prompts, "still there?", re-login).

`spike/out/` and the Chrome profile are gitignored. Do not paste `ws-frames.log` anywhere
public; it can carry session tokens.
