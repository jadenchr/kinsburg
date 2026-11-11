# Kinsburg scripts

```sh
node scripts/generate-demo.mjs [count=1200] [seed=kinsburg]   # writes public/residents.json (CityData, demo:true)
node scripts/generate-demo.mjs 1200 kinsburg --no-write        # validate + ASCII preview only
node scripts/generate-demo.mjs --check                         # stability, determinism, 100k timing (writes nothing)
```

Each run validates the output: the tile string, overlaps, every plot touching a road, every road tile
on a named street, unique addresses, resident↔plot links, handles and the day order. It also prints an ASCII
overview: `#` occupied house, `o` empty house, `$` shop, `C` civic, `+` road, `=` plaza, `"` park, `^` trees,
`,` farm, `~` water, `:` sand, and H/F/K/M/L/W for town hall, fountain, market, monument, lighthouse, windmill.

## `shared/city-layout.mjs` (no dependencies; works in Node and the browser)

| export | what it does |
| --- | --- |
| `buildCity({ seed, capacity })` | Builds the map with at least `capacity` house plots. Returns `{ width, height, tiles, streets, plots, landmarks, fillOrder, originX, originY, rings, chunks, houseCapacity, streetOf }` |
| `capacityFor(n)` | House plots to build for `n` residents: `ceil(1.45n)`, so about 31% stay empty |
| `assignResidents(city, residents)` | Gives `residents[i]` the plot `fillOrder[i]`, sets `plot.residentId`, and returns the residents with `plotId` set |
| `nextFreePlot(city, count)` | The plot id the next resident would get (-1 if the city is full) |
| `toCityData(city, residents, opts)` | Builds the `CityData` object from `src/types.ts` |
| `validateCityData(data, { jobs, streetOf })` | Throws on any broken invariant; returns stats |
| `asciiMap(data, cols, rows)` | Downsampled text preview |
| `rngFrom(...parts)`, `mulberry32`, `hashString` | Seeded RNG helpers |

**Growth model.** The world is a grid of 20×20 neighbourhoods ("chunks") with arterial roads between them.
Chunks are unlocked in a fixed order for each seed: the centre (plaza, town hall, fountain, market, Founders
Monument park, school/library/clinic), then the lake (sand shore, lighthouse), then outward by distance.
A chunk's content depends only on the seed and its coordinates. Plot ids follow unlock order, and inside a
chunk they run nearest-the-town-hall first, so a bigger city only **appends** plots. Resident #k always gets
house plot `fillOrder[k-1]`, and street ids and house numbers stay the same as the city grows. The only thing
that changes is the map window. It stays centred on the town hall, so when a new ring opens, all x/y
coordinates shift by the same offset (`originX/originY` gives the centre's position). Chunks that are not
unlocked yet are countryside (farms with the windmill, forest, meadows with ponds).
Kinsfolk Avenue winds east to west through the whole map.

To handle a MOVE IN for a real resident: append them to the ordered resident list, then call
`buildCity({ seed, capacity: capacityFor(n) })` and `assignResidents`. Everyone already placed keeps their home.
