// The daily neuron budget (docs/SDD.md, "Budget guard"). Pure functions; the
// Keeper Durable Object keeps the numbers in its SQLite (one instance, so a
// reservation is atomic) and calls these.
//
// Every AI call reserves its worst-case estimate first (input at 4 characters
// per token plus the max_tokens cap). Reservations ("holds") count as spent
// until settled with the actual cost, so concurrent calls can't overshoot.
// Nothing we start can take the day past hardStop (9,500 of the 10,000 free).

/** Neurons for a generation: input tokens and the max output, at a model's rates. */
export function genNeurons(rates, inTokens, maxOut) {
  return (inTokens * rates.in + maxOut * rates.out) / 1e6;
}

export function embedNeurons(rates, inTokens) {
  return (inTokens * rates.in) / 1e6;
}

/** A fresh day. */
export function emptyDay(day) {
  return { day, used: 0, questions: 0, inbox: 0, ingest: 0, held: { questions: 0, inbox: 0, ingest: 0 }, exhausted: false };
}

const POOLS = ["questions", "inbox", "ingest"];

/**
 * What each pool may still spend right now.
 * @param {ReturnType<typeof emptyDay>} d
 * @param {{ hardStop: number, inboxReserve: number, ingestReserve: number, releaseHourUtc: number }} b
 * @param {number} now
 * @param {{ firstIngest?: boolean }} opts  the first ingest may use the questions' pool too
 */
export function available(d, b, now, { firstIngest = false } = {}) {
  if (d.exhausted) return { questions: 0, inbox: 0, ingest: 0, hardLeft: 0 };
  const held = POOLS.reduce((n, p) => n + (d.held[p] ?? 0), 0);
  const hardLeft = Math.max(0, b.hardStop - d.used - held);
  const released = new Date(now).getUTCHours() >= b.releaseHourUtc;
  const inboxLeft = Math.max(0, b.inboxReserve - d.inbox - (d.held.inbox ?? 0));
  const ingestLeft = Math.max(0, b.ingestReserve - d.ingest - (d.held.ingest ?? 0));
  const questions = Math.max(0, hardLeft - (released ? 0 : inboxLeft + ingestLeft));
  return {
    questions,
    inbox: Math.min(hardLeft, inboxLeft),
    ingest: firstIngest ? Math.max(0, hardLeft - (released ? 0 : inboxLeft)) : Math.min(hardLeft, ingestLeft),
    hardLeft,
  };
}

/**
 * The mode for a question: full, lean or search (docs/SDD.md: full while the
 * questions' pool >= leanBelow, lean down to searchBelow, then search), and
 * never a mode whose estimate doesn't fit.
 */
export function questionMode(left, est, b) {
  if (left >= b.leanBelow && left >= est.full) return "full";
  if (left >= b.searchBelow && left >= est.lean) return "lean";
  return "search";
}

/** The mode now, for display (no estimate). */
export function displayMode(d, b, now) {
  const a = available(d, b, now);
  return questionMode(a.questions, { full: 0, lean: 0 }, b);
}

export const POOL_NAMES = POOLS;
