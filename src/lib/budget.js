// A per-invocation subrequest budget. From perchlight-forms src/lib/budget.js
// via perchlight-hooks. Workers Free allows 50 subrequests per invocation;
// whether D1, Durable Object and AI/Vectorize binding calls count isn't
// confirmed, so every one is counted and an alarm run keeps under 40
// (docs/SDD.md, "Runs in the Keeper DO's alarm"), with a reserve for the
// run's own bookkeeping.

export const ALARM_BUDGET = 40;
/** Held back in every alarm run for state writes, the heartbeat and the final D1 batch. */
export const ALARM_RESERVE = 5;

export function newBudget(total = ALARM_BUDGET) {
  return { left: total, used: 0 };
}

/** Takes n from the budget if it's there. */
export function spend(budget, n = 1) {
  if (!budget) return true;
  if (budget.left < n) return false;
  budget.left -= n;
  budget.used += n;
  return true;
}

/** Whether n more fit while keeping `reserve` back. */
export function fits(budget, n, reserve = 0) {
  return !budget || budget.left - reserve >= n;
}
