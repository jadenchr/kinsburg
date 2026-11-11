// Contract for the page UI (everything drawn in HTML over the canvas).
// Implemented in src/ui/index.ts.
import type { CityData, Resident } from '../types';
import type { SkyState } from '../theme';

export interface CityStats {
  /** city day number, Day 1 = founding day */
  day: number;
  residents: number;
  /** true while the city holds generated sample residents */
  demo: boolean;
}

export interface AppUI {
  /** Loading splash with 0..1 progress. */
  setLoading(progress: number): void;
  /** Hide the splash. */
  ready(): void;
  /** Data failed to load. `retry` reloads. */
  showError(retry: () => void): void;
  setStats(stats: CityStats): void;
  /** Re-tint the UI for the time of day and update the clock. */
  setSky(sky: SkyState, now: Date): void;
  /** Open the resident card. */
  openResident(resident: Resident, data: CityData): void;
  closeCard(): void;
  /** Search found nobody with that handle. */
  showNotFound(handle: string, account: string): void;
  /** User submitted a search (raw text as typed). */
  onSearch(cb: (query: string) => void): void;
  /** Card was closed by the user. */
  onCardClosed(cb: () => void): void;
}

export type CreateUI = (root: HTMLElement) => AppUI;
