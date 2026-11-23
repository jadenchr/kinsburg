// Kinsburg politics: automatic elections, the mayor's approval, protests and recalls. Shared by
// the Worker (which runs it) and the browser (which shows it). Plain ESM. Types: politics.d.mts.
//
// The cycle: nominations (residents comment RUN FOR MAYOR) -> voting (VOTE @name on any post) ->
// a two-week term -> the next election. Residents who think the mayor isn't doing the job comment
// PROTEST; once enough of the town's active residents protest within a week, a recall election
// starts at once (the mayor may run again). Protests only ever come from real comments.

export const TERM_DAYS = 14;
export const NOMINATION_DAYS = 3;
export const RECALL_NOMINATION_DAYS = 1;
export const VOTING_DAYS = 2;
export const MAX_CANDIDATES = 6;
/** Elections start once the town has this many residents. */
export const MIN_RESIDENTS = 10;
/** Protest threshold: at least PROTEST_MIN people, and PROTEST_SHARE of residents active this week. */
export const PROTEST_MIN = 5;
export const PROTEST_SHARE = 0.25;
export const PROTEST_WINDOW_DAYS = 7;
/** The mayor can fund one stat a day from the treasury. */
export const FUND_COST = 200;
export const FUND_BOOST = 6;
export const FUND_STATS = { health: 'health', hospital: 'health', safety: 'safety', police: 'safety', education: 'education', school: 'education', schools: 'education', happiness: 'happiness', parks: 'happiness', park: 'happiness' };

const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/** "RUN FOR MAYOR", "I'm running for mayor", "nominate me". */
export function matchesRunForMayor(text) {
  const t = fold(text);
  return /^(i m |im |i am )?(run|running) for mayor( |$)/.test(t) || /^nominate me( |$)/.test(t);
}

/** "PROTEST", "protest!", "I protest", "#protest". Must lead the comment. */
export function matchesProtest(text) {
  return /^(i )?protest( |$)/.test(fold(text));
}

/** The stat a mayor's "FUND HEALTH" / "fund schools" comment funds, or null. */
export function parseFund(text) {
  const m = /^fund (the )?([a-z]+)/.exec(fold(text));
  return m ? FUND_STATS[m[2]] ?? null : null;
}

/** Protesters needed to force a recall, given how many residents were active this week. */
export function protestThreshold(active) {
  return Math.max(PROTEST_MIN, Math.ceil(active * PROTEST_SHARE));
}

/**
 * Approval 0..100: how the city is doing (average of the four stats), minus the share of this
 * week's active residents who are protesting.
 */
export function approvalOf(stats, protesters, active) {
  const avg = (stats.health + stats.safety + stats.education + stats.happiness) / 4;
  const penalty = (100 * protesters) / Math.max(10, active);
  return Math.max(0, Math.min(100, Math.round(avg - penalty)));
}
