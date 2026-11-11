// Shared contracts for Kinsburg. Every module (city renderer, UI, data generator)
// codes against these types — change them only in this file.

/** One character per map tile, row-major, in CityData.tiles. */
export const TILE = {
  grass: 'g',
  road: 'r',
  water: 'w',
  park: 'p',
  plaza: 'z',
  farm: 'f',
  trees: 't',
  sand: 's',
} as const;
export type TileChar = (typeof TILE)[keyof typeof TILE];

export const JOBS = [
  'Baker', 'Barista', 'Teacher', 'Nurse', 'Florist', 'Carpenter', 'Librarian',
  'Fisher', 'Farmer', 'Painter', 'Musician', 'Mail carrier', 'Mechanic', 'Chef',
  'Gardener', 'Firefighter', 'Tailor', 'Shopkeeper', 'Beekeeper', 'Photographer',
  'Lighthouse keeper', 'Bus driver', 'Doctor', 'Coder', 'Architect', 'Potter',
] as const;
export type Job = (typeof JOBS)[number];

/** Paid status perks. Cosmetic only — never power. */
export type Perk = 'star' | 'goldRoof' | 'monument' | 'street';

export interface Resident {
  /** Stable id, lowercase handle without "@". */
  id: string;
  /** Instagram handle without "@", as the person writes it. */
  handle: string;
  /** Resident number in order of moving in, starting at 1. */
  number: number;
  /** City day they moved in (Day 1 = founding day). */
  joinedDay: number;
  job: Job;
  /** Plot.id of their home. */
  plotId: number;
  /** 0..11 — picks roof colour, wall colour and roof shape deterministically. */
  houseStyle: number;
  perks: Perk[];
}

export interface Street {
  id: number;
  /** e.g. "Larkspur Lane" */
  name: string;
}

export type PlotKind = 'house' | 'shop' | 'civic';

/** A building lot. Coordinates are tile units, (0,0) top-left of the map grid. */
export interface Plot {
  id: number;
  x: number;
  y: number;
  /** footprint in tiles, 1 for houses */
  w: number;
  h: number;
  kind: PlotKind;
  streetId: number;
  houseNumber: number;
  /** Resident.id living here, if any. */
  residentId?: string;
}

export type LandmarkKind = 'townhall' | 'fountain' | 'monument' | 'lighthouse' | 'windmill' | 'market';

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CityData {
  name: string;
  /** Instagram handle of the city account, without "@". */
  account: string;
  /** ISO date of Day 1. */
  foundedISO: string;
  /** Map size in tiles. */
  width: number;
  height: number;
  /** width*height chars, see TILE. */
  tiles: string;
  streets: Street[];
  plots: Plot[];
  landmarks: Landmark[];
  residents: Resident[];
  /** true while the city is filled with generated demo residents. */
  demo: boolean;
}
