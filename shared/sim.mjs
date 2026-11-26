// Kinsburg city simulation: the rules shared by the Worker (which runs it) and the browser (which
// shows it). Plain ESM, no dependencies. Types: sim.d.mts.
//
// The city has five stats (0..100): health, safety, education, happiness and a treasury in town
// coins. Every 15 minutes the Worker ticks: stats drift toward targets set by how well each
// service is staffed (and how active its workers are), incidents may start, and incidents past
// their deadline fail. Residents with the right job comment RESPOND to handle an incident;
// once enough have responded it's resolved, and the responders earn coins and a hero badge.
// Nothing permanent or upsetting: a failed fire damages a house until a carpenter repairs it.

/**
 * Incident kinds. jobs: who can respond. base: responders needed in a small town (more as the
 * town grows, see neededFor). hours: time to respond. station: where vehicles come from.
 */
export const INCIDENTS = {
  fire: { label: 'Kitchen fire', jobs: ['Firefighter'], base: 2, hours: 4, station: 'firestation', vehicle: 'engine', weight: 3 },
  burglary: { label: 'Break-in', jobs: ['Police officer'], base: 1, hours: 6, station: 'police', vehicle: 'police', weight: 3 },
  crash: { label: 'Fender-bender', jobs: ['Police officer', 'Doctor', 'Nurse'], base: 2, hours: 3, station: 'police', vehicle: 'police', weight: 2 },
  flu: { label: 'Flu week', jobs: ['Doctor', 'Nurse'], base: 3, hours: 12, station: 'hospital', vehicle: 'ambulance', weight: 1 },
  lostpet: { label: 'Lost pet', jobs: ['Vet', 'Police officer'], base: 1, hours: 8, station: 'vet', vehicle: null, weight: 2 },
  exam: { label: 'Exam week', jobs: ['Teacher'], base: 2, hours: 12, station: 'school', vehicle: null, weight: 1 },
  repair: { label: 'Storm damage', jobs: ['Carpenter'], base: 1, hours: 48, station: null, vehicle: null, weight: 1 },
};
export const INCIDENT_KINDS = Object.keys(INCIDENTS);

/** Stats and the jobs that hold them up, with the share of residents a fully staffed town has. */
export const STAT_JOBS = {
  health: { jobs: ['Doctor', 'Nurse', 'Surgeon', 'Paramedic', 'Midwife'], share: 0.08 },
  safety: { jobs: ['Police officer', 'Firefighter', 'Detective', 'Security guard', 'Lifeguard'], share: 0.08 },
  education: { jobs: ['Teacher', 'Librarian', 'Professor', 'Principal', 'Tutor'], share: 0.06 },
};
export const STATS = ['health', 'safety', 'education', 'happiness'];

/** What happens to the stats when an incident is resolved (+) or fails (-). */
export const OUTCOME = {
  fire: { stat: 'safety', win: 3, lose: -6 },
  burglary: { stat: 'safety', win: 3, lose: -6 },
  crash: { stat: 'health', win: 2, lose: -4 },
  flu: { stat: 'health', win: 5, lose: -8 },
  lostpet: { stat: 'happiness', win: 4, lose: -2 },
  exam: { stat: 'education', win: 5, lose: -5 },
  repair: { stat: 'happiness', win: 4, lose: 0 },
};

export const COINS = { respond: 10, duty: 2, repair: 15 };
/** Rare pets can be bought with town coins instead of money. */
export const PET_COIN_PRICE = 150;

/** Responders needed: grows slowly with the town so big towns need teamwork. */
export function neededFor(kind, residents) {
  const d = INCIDENTS[kind];
  return Math.min(6, d.base + Math.floor(Math.max(0, residents - 100) / 250));
}

const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/**
 * "RESPOND", "responding 🚒", "on my way", "omw", "on duty", "I'll help": a resident answering a
 * call (or clocking in for the day when there's nothing to answer). Must lead the comment.
 */
export function matchesRespond(text) {
  return /^(respond|responding|on duty|on my way|omw|on it|i ll help|ill help|help|dispatch|en route|clock in|clocking in)( |$)/.test(fold(text));
}

/** Clamp to 0..100. */
export const clampStat = (x) => Math.max(0, Math.min(100, x));

/**
 * Where a stat is heading: 35 with nobody in those jobs, up to 100 when the share of residents
 * in them meets `share` (active workers count double). Happiness follows the others, plus pets,
 * minus unrepaired damage.
 */
export function statTargets({ residents, workers, active, pets, damaged }) {
  const out = {};
  const n = Math.max(1, residents);
  for (const [stat, { jobs, share }] of Object.entries(STAT_JOBS)) {
    let w = 0;
    for (const j of jobs) w += (workers[j] ?? 0) + 2 * (active[j] ?? 0);
    out[stat] = clampStat(35 + 65 * Math.min(1, w / (n * share * 1.5)));
  }
  const base = (out.health + out.safety + out.education) / 3;
  out.happiness = clampStat(base + Math.min(10, (pets / n) * 40) - 4 * damaged);
  return out;
}
