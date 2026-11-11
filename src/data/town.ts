// Town info: mayor, polls with live tallies, sponsors and perk links.
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
}
export type PerkKey = 'star' | 'goldRoof' | 'monument' | 'street' | 'poster';
export interface TownInfo {
  day: number;
  mayor: { handle: string; sinceDay: number } | null;
  polls: TownPoll[];
  sponsors: { name: string; message: string; url: string | null }[];
  perkLinks: Partial<Record<PerkKey, { url: string; price: string }>>;
  /** comments needed for storey 2, 3, 4 */
  levelAt: number[];
  account: string;
}

const EMPTY: TownInfo = { day: 1, mayor: null, polls: [], sponsors: [], perkLinks: {}, levelAt: [3, 10, 30], account: 'kinsburgtown' };

async function getJSON(url: string): Promise<TownInfo> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(url);
  return { ...EMPTY, ...((await res.json()) as Partial<TownInfo>) };
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
    return await getJSON('/town.json');
  } catch {
    return EMPTY;
  }
}
