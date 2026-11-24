// Town info: mayor, polls with live tallies, sponsors, perk links and the city simulation.
import type { IncidentKind, Stat } from '../../shared/sim.mjs';
// Live from the Worker (/api/city/town.json); the static demo file /town.json otherwise.
export interface TownPollOption {
  key: string;
  label: string;
  handle?: string;
  votes: number;
}
export interface TownPoll {
  id: string;
  kind: 'election' | 'decision';
  question: string;
  status: 'open' | 'closed';
  closesAt: string;
  total: number;
  options: TownPollOption[];
  result: { winner: string | null; label: string | null } | null;
  /** automatic elections: comment VOTE and the candidate's @ on any post */
  anywhere?: boolean;
}

/** Elections, approval and the mayor's fund (rules in shared/politics.mjs). */
export interface TownPolitics {
  mayor: { handle: string; sinceDay: number; termEndsDay: number; approval: number } | null;
  /** nominations: residents comment RUN FOR MAYOR; voting: the poll with id pollId (in TownInfo.polls) */
  election: { id: string; phase: 'nominations' | 'voting'; nominationsCloseAt: string; pollId: string | null; candidates: string[] } | null;
  /** the mayor can comment FUND HEALTH / SAFETY / EDUCATION / PARKS once a day */
  fund: { cost: number; boost: number };
}
export type PerkKey = 'star' | 'goldRoof' | 'monument' | 'street' | 'poster';

/** Something happening in town (rules in shared/sim.mjs). target = handle of the house it's at. */
export interface TownIncident {
  id: number;
  kind: IncidentKind;
  /** e.g. "Kitchen fire" */
  label: string;
  target: string | null;
  needed: number;
  status: 'open' | 'resolved' | 'failed';
  createdAt: string;
  deadline: string;
  closedAt: string | null;
  /** handles who responded, in order */
  responders: string[];
}
export interface TownSim {
  /** 0..100 */
  stats: Record<Stat, number>;
  /** city treasury, town coins */
  treasury: number;
  open: TownIncident[];
  /** resolved or failed in the last 2 days, newest first */
  recent: TownIncident[];
  ofTheWeek: { title: string; handle: string; count: number }[];
}
export interface TownInfo {
  day: number;
  mayor: { handle: string; sinceDay: number } | null;
  polls: TownPoll[];
  sponsors: { name: string; message: string; url: string | null }[];
  perkLinks: Partial<Record<PerkKey, { url: string; price: string }>>;
  /** comments needed for storey 2, 3, 4 */
  levelAt: number[];
  account: string;
  /** the city simulation; missing on an older Worker */
  sim?: TownSim;
  /** what commenters got built, oldest first (id = build order, never reused); missing on an older Worker */
  builds?: { id: number; kind: string; by: string; day: number; likes: number }[];
  /** plots held for a bestie: the vacant lot's resident number, and days left */
  holds?: { number: number; days: number }[];
  /** pairs of resident handles who are besties */
  besties?: [string, string][];
  /** open build requests, most liked first (at most 10) */
  requests?: { kind: string; likes: number; count: number }[];
  /** limited-edition homes: how many of each are taken (first come first served) */
  homes?: Record<'villa' | 'skyscraper', { limit: number; taken: number }>;
  /** elections, approval and the mayor's fund; missing on an older Worker */
  politics?: TownPolitics;
}

const EMPTY: TownInfo = { day: 1, mayor: null, polls: [], sponsors: [], perkLinks: {}, levelAt: [3, 10, 30], account: 'kinsburgtown' };

async function getJSON(url: string): Promise<TownInfo> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(url);
  return { ...EMPTY, ...((await res.json()) as Partial<TownInfo>) };
}

/** The demo file's incident times are fixed; shift them so its newest call started just now. */
function rebase(t: TownInfo & { generatedAt?: string }): TownInfo {
  const at = t.generatedAt ? Date.parse(t.generatedAt) : NaN;
  if (!t.sim || !Number.isFinite(at)) return t;
  const shift = Date.now() - at - 60_000;
  const move = (iso: string | null) => (iso ? new Date(Date.parse(iso) + shift).toISOString() : iso);
  const fix = <T extends { createdAt: string; deadline: string; closedAt: string | null }>(i: T): T => ({ ...i, createdAt: move(i.createdAt)!, deadline: move(i.deadline)!, closedAt: move(i.closedAt) });
  return { ...t, sim: { ...t.sim, open: t.sim.open.map(fix), recent: t.sim.recent.map(fix) } };
}

/** Never throws: an empty town just hides those sections. */
export async function loadTown(demo: boolean): Promise<TownInfo> {
  if (!demo) {
    try {
      return await getJSON('/api/city/town.json');
    } catch {
      /* fall through to the demo file */
    }
  }
  try {
    return rebase(await getJSON('/town.json'));
  } catch {
    return EMPTY;
  }
}
