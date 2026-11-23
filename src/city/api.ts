// Contract for the city renderer. Implemented in src/city/index.ts.
import type { CityData, Resident } from '../types';
import type { SkyState } from '../theme';
import type { TownIncident } from '../data/town';

/** Something the city built because commenters asked for it (see shared/builds.mjs). */
export interface BuildInfo {
  /** 1-based build order, never reused: build #k stands on build site #k */
  id: number;
  kind: string;
  /** handle of who asked */
  by: string;
  /** city day it was built */
  day: number;
  likes: number;
}

/** A house plot kept empty for a bestie. */
export interface Hold {
  /** resident number whose plot (a "vacant.lot.<number>" row) is held */
  number: number;
  /** days left */
  days: number;
}

/** What a tap on a hidden spot found. */
export interface SecretRef {
  index: number;
  name: string;
}

export interface CityView {
  /**
   * Builds and held plots. Builds stand on fixed sites that never move; holds draw a sign on the
   * vacant lot. Cheap to call again: nothing is repainted unless a build or hold was added or removed.
   */
  setExtras(builds: BuildInfo[], holds: Hold[]): void;
  /** Bestie pairs (resident handles): a small heart floats between the two homes. */
  setBesties(pairs: [string, string][]): void;
  /** Hidden spots the visitor already found (indexes), which get a sparkle. */
  setSecretsFound(found: number[]): void;
  /** Called when a build is tapped. */
  onBuild(cb: (b: BuildInfo) => void): void;
  /** Called when a hidden spot is tapped (always, found or not). */
  onSecret(cb: (s: SecretRef) => void): void;
  /** Called when a held lot is tapped. */
  onHold(cb: (h: Hold) => void): void;
  /** Smoothly pan + zoom to a build. */
  focusBuild(id: number): void;
  /** Load (or reload) the whole city. Centres the camera on the town hall. */
  setData(data: CityData): void;
  /** Recolour for a time of day. Called on start and every minute. */
  setSky(sky: SkyState): void;
  /** Smoothly pan + zoom to a resident's home and highlight it. */
  focusResident(id: string): void;
  /** Remove the highlight (e.g. when the card closes). */
  clearHighlight(): void;
  /**
   * Open incidents from the simulation: drawn at their house (fire, police car, scaffolding…),
   * with the station's vehicle driving there along the roads. Replaces the previous list.
   */
  setIncidents(incidents: TownIncident[]): void;
  /** Sponsor billboards on the town square (rotates every 8 s when there are several). */
  setBillboards(lines: Billboard[]): void;
  /** Called when the user taps/clicks a house (resident) or empty ground (null). */
  onSelect(cb: (resident: Resident | null) => void): void;
  /** Called instead of onSelect when the tap lands on a city building (hospital, KPD, town hall…). */
  onBuilding(cb: (building: BuildingRef) => void): void;
  /**
   * Reel mode (used only by src/reel.ts, behind ?reel=1). Stops the live animation loop,
   * detaches input, fixes the canvas at exactly width×height device px (DPR 1) and returns
   * a controller that renders complete frames on demand. Call after setData().
   */
  enterReel(width: number, height: number): ReelControl;
  destroy(): void;
}

/** A tapped city building. kind is a civic service or a landmark kind. */
export interface BuildingRef {
  kind: 'hospital' | 'school' | 'vet' | 'library' | 'police' | 'firestation' | 'townhall';
  name: string;
}

export interface Billboard {
  /** sponsor name, small */
  name: string;
  /** the big line */
  message: string;
}

/** Camera in world px: the world point at the frame centre, and device px per world px. */
export interface ReelCamera {
  x: number;
  y: number;
  zoom: number;
}

export interface ReelFrame {
  /** seconds since the reel started — drives every animation (never the wall clock) */
  t: number;
  sky: SkyState;
  camera: ReelCamera;
  /** resident ids to ring with a pulsing highlight ('next', 'lot:<id>', 'build:<id>', 'hold:<n>' also work) */
  highlights: string[];
  /** resident ids drawn with every light off (an empty-looking home at night) */
  dark?: string[];
}

export interface ReelTarget {
  /** world px of the footprint centre on the ground */
  x: number;
  y: number;
  /** height above ground, world px */
  height: number;
  /** footprint size in tiles */
  size: number;
}

export interface ReelControl {
  /** Where a resident's home is (by resident id), or null. */
  resident(id: string): ReelTarget | null;
  /** The empty building lot closest to a resident's home (for "this lot is waiting" shots). */
  emptyLotNear(id: string): ReelTarget | null;
  /** the empty plot the next resident will get */
  nextLot(): ReelTarget | null;
  /** Where a landmark is (by Landmark.kind, e.g. 'townhall'), or null. */
  landmark(kind: string): ReelTarget | null;
  /** A build by id, or the highest id with 'latest'; null if there is none or it has no site. */
  build(id: number | 'latest'): ReelTarget | null;
  /** A hidden spot, 0-based. */
  secret(index: number): ReelTarget | null;
  /** The lot held under a resident number. */
  hold(number: number): ReelTarget | null;
  /** World-px bounding box of every lived-in home (falls back to the whole map). */
  homesBounds(): { minX: number; minY: number; maxX: number; maxY: number };
  /** Render one frame synchronously. Every chunk the frame needs is built first. */
  render(frame: ReelFrame): void;
}

export type CreateCityView = (canvas: HTMLCanvasElement) => CityView;
