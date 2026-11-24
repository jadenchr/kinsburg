// Kinsburg politics: automatic elections, the mayor's approval and the mayor's town fund. Shared by
// the Worker (which runs it) and the browser (which shows it). Plain ESM. Types: politics.d.mts.
//
// The cycle: nominations (residents comment RUN FOR MAYOR) -> voting (VOTE @name on any post) ->
// a two-week term -> the next election. Kinsburg is a positive place: there are no protests or
// recalls; a mayor's record is simply how the town is doing.

export const TERM_DAYS = 14;
export const NOMINATION_DAYS = 3;
export const VOTING_DAYS = 2;
export const MAX_CANDIDATES = 6;
/** Elections start once the town has this many residents. */
export const MIN_RESIDENTS = 10;
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

/** The stat a mayor's "FUND HEALTH" / "fund schools" comment funds, or null. */
export function parseFund(text) {
  const m = /^fund (the )?([a-z]+)/.exec(fold(text));
  return m ? FUND_STATS[m[2]] ?? null : null;
}

/** Approval 0..100: how the city is doing (the average of the four stats). */
export function approvalOf(stats) {
  return Math.max(0, Math.min(100, Math.round((stats.health + stats.safety + stats.education + stats.happiness) / 4)));
}
