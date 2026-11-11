// Address lookup (plot + street) for a resident, cached per CityData.
import type { CityData, Plot, Resident } from '../types';

interface Index {
  plots: Map<number, Plot>;
  streets: Map<number, string>;
}
const cache = new WeakMap<CityData, Index>();

function indexOf(data: CityData): Index {
  let idx = cache.get(data);
  if (!idx) {
    idx = {
      plots: new Map(data.plots.map((p) => [p.id, p])),
      streets: new Map(data.streets.map((s) => [s.id, s.name])),
    };
    cache.set(data, idx);
  }
  return idx;
}

/** "14 Larkspur Lane", or '' if the plot or street is missing. */
export function addressOf(resident: Resident, data: CityData): string {
  const idx = indexOf(data);
  const plot = idx.plots.get(resident.plotId);
  if (!plot) return '';
  const street = idx.streets.get(plot.streetId);
  return street ? `${plot.houseNumber} ${street}` : '';
}
