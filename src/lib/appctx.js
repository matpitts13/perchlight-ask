// Shared bits: the time source and test hooks (tests replace these).

/** The time source (tests replace clock.now). */
export const clock = { now: () => Date.now() };

/** Tests only: bindings merged over the Durable Object's env (fake AI, Vectorize, send_email, a broken D1). */
export const testHooks = { env: null };

/** The Keeper's stub: one instance. */
export function keeperStub(env) {
  return env.KEEPER.get(env.KEEPER.idFromName("keeper"));
}
