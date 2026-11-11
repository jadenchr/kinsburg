// Contract for the city renderer. Implemented in src/city/index.ts.
import type { CityData, Resident } from '../types';
import type { SkyState } from '../theme';

export interface CityView {
  /** Load (or reload) the whole city. Centres the camera on the town hall. */
  setData(data: CityData): void;
  /** Recolour for a time of day. Called on start and every minute. */
  setSky(sky: SkyState): void;
  /** Smoothly pan + zoom to a resident's home and highlight it. */
  focusResident(id: string): void;
  /** Remove the highlight (e.g. when the card closes). */
  clearHighlight(): void;
  /** Called when the user taps/clicks a house (resident) or empty ground (null). */
  onSelect(cb: (resident: Resident | null) => void): void;
  /**
   * Reel mode (used only by src/reel.ts, behind ?reel=1). Stops the live animation loop,
   * detaches input, fixes the canvas at exactly width×height device px (DPR 1) and returns
   * a controller that renders complete frames on demand. Call after setData().
   */
  enterReel(width: number, height: number): ReelControl;
  destroy(): void;
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
  /** resident ids to ring with a pulsing highlight */
  highlights: string[];
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
  /** Where a landmark is (by Landmark.kind, e.g. 'townhall'), or null. */
  landmark(kind: string): ReelTarget | null;
  /** World-px bounding box of every lived-in home (falls back to the whole map). */
  homesBounds(): { minX: number; minY: number; maxX: number; maxY: number };
  /** Render one frame synchronously. Every chunk the frame needs is built first. */
  render(frame: ReelFrame): void;
}

export type CreateCityView = (canvas: HTMLCanvasElement) => CityView;
