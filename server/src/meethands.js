// Raised hands in a meeting, in the order they went up: the server stamps when each was raised, so
// everyone sees the same queue (1st, 2nd…) and the host can call on people fairly.

/** Someone's state after a change: hand_at is when their hand went up (kept while it stays up). */
export function nextState(prev = {}, patch = {}, t = Date.now()) {
  const s = { ...prev, ...patch };
  const hand = !!s.hand;
  return {
    mic: s.mic !== false, cam: s.cam !== false, hand, screen: !!s.screen, rec: !!s.rec, // rec: they're recording the meeting (everyone is shown)
    hand_at: hand ? (prev.hand && prev.hand_at ? prev.hand_at : t) : null,
  };
}

/** Who has a hand up, first raised first: [id]. `people` is [{ id, state }]. */
export const handQueue = (people) => people.filter((p) => p.state?.hand).sort((a, b) => (a.state.hand_at || 0) - (b.state.hand_at || 0)).map((p) => p.id);
