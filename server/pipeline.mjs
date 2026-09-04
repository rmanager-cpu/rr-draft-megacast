// Wire frames in, reconciled picks out. The only place that knows a frame from
// a pick, so the reconciler stays about draft logic and the sources stay about
// transport. Live, replay and synthetic all go through here.
//
// The reconciler is fetched through getReconciler() rather than captured, because
// how many teams and rounds this draft has is itself something the first room
// snapshot tells us. It does not exist until the first INIT lands.

import { decodeInit } from "./initdecode.mjs";

export function createFrameHandler({
  getReconciler,
  leagueId,
  isPreDraft = () => false,
  onClock = () => {},
  onSelecting = () => {},
  onState = () => {},
  onWarn = () => {},
  onRoomSnapshot = () => {},
}) {
  let sawFirstInit = false;

  return function handleFrame(frame) {
    switch (frame.cmd) {
      case "INIT": {
        const res = decodeInit(frame.bytes, { leagueId });
        if (!res.ok) {
          // Fail closed and say so. A board built on a misread snapshot is worse
          // than a board that admits it does not know yet.
          onWarn("could not read the room snapshot: " + res.reason);
          return;
        }
        // Pre-filled picks are keepers only if the draft has not started. Join
        // a draft already in progress and those same records are simply picks we
        // were not there to see - calling them keepers would be a lie on screen.
        const phase = !sawFirstInit && isPreDraft() ? "pre" : "live";
        sawFirstInit = true;
        onRoomSnapshot(res);
        getReconciler()?.adoptInit(res.records, { phase });
        return;
      }
      case "SELECTED":
        getReconciler()?.onSelected({ teamId: frame.teamId, playerId: frame.playerId, slot: frame.slot });
        return;
      case "SELECTING":
        onSelecting({ teamId: frame.teamId, clockMs: frame.clockMs });
        return;
      case "CLOCK":
        onClock({ teamId: frame.teamId, msLeft: frame.msLeft });
        return;
      case "STATE":
        onState(frame.state);
        return;
      default:
        return;
    }
  };
}
