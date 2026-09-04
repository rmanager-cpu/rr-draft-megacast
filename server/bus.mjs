// A publish/subscribe bus small enough to read in one sitting.
//
// The whole show is wired through this: the reconciler publishes picks, the
// reveal queue and the audio channel subscribe. Nothing subscribes back into
// the layer above it, which is what keeps "visuals never wait on audio" a
// structural property rather than a rule someone has to remember.
//
// A throwing subscriber must never take down the process mid-draft, so every
// handler is called inside a try/catch and a failure is reported, not raised.

export function createBus({ onError = (e, event) => console.error("bus " + event + ":", e) } = {}) {
  const handlers = new Map(); // event -> Set<fn>

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  function emit(event, payload) {
    const set = handlers.get(event);
    if (!set) return 0;
    let delivered = 0;
    for (const fn of [...set]) {
      try {
        fn(payload, event);
        delivered++;
      } catch (e) {
        onError(e, event);
      }
    }
    return delivered;
  }

  return { on, off, emit, get events() { return [...handlers.keys()]; } };
}
