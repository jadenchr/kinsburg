// "Build what you ask" and bestie neighbours: the comment rules shared by the Worker and the browser.
// Plain ESM, no dependencies. Types: builds.d.mts.
//
// Build requests
//   A comment asking for something the city can build ("build a pool", "can we get a ferris wheel",
//   "Eiffel Tower with an infinity pool!") becomes a request for one BUILDS kind. Once a day the
//   most-liked requests are built (worker/src/builds.ts); the browser places build #k on build site
//   #k (prefix-stable, like house plots), so nothing ever moves.
//
// Bestie neighbours
//   "MOVE IN @friend" moves the commenter in and holds the next house plot for @friend for
//   BESTIE_HOLD_DAYS. The friend only becomes a resident once they comment MOVE IN themselves.

/**
 * Append-only: a stored build's kind is a key of this list, and the browser draws each key.
 * words: lowercase phrases (letters and spaces only) that name the thing in a comment.
 */
export const BUILDS = [
  { kind: 'pool', label: 'Swimming pool', emoji: '🏊', words: ['pool', 'swimming pool', 'infinity pool', 'water park', 'waterpark'] },
  { kind: 'fountain', label: 'Fountain', emoji: '⛲', words: ['fountain', 'wishing well'] },
  { kind: 'park', label: 'Park', emoji: '🌳', words: ['park', 'forest', 'trees', 'picnic'] },
  { kind: 'playground', label: 'Playground', emoji: '🛝', words: ['playground', 'slide', 'swings', 'swing'] },
  { kind: 'ferris', label: 'Ferris wheel', emoji: '🎡', words: ['ferris wheel', 'ferris', 'big wheel', 'amusement park', 'theme park', 'funfair'] },
  { kind: 'carousel', label: 'Carousel', emoji: '🎠', words: ['carousel', 'merry go round', 'roller coaster', 'rollercoaster'] },
  { kind: 'castle', label: 'Castle', emoji: '🏰', words: ['castle', 'palace', 'kingdom'] },
  { kind: 'tower', label: 'Tower', emoji: '🗼', words: ['tower', 'eiffel tower', 'skyscraper', 'eiffel'] },
  { kind: 'statue', label: 'Statue', emoji: '🗽', words: ['statue', 'statue of liberty', 'sculpture'] },
  { kind: 'garden', label: 'Flower garden', emoji: '🌷', words: ['garden', 'flower garden', 'flowers', 'greenhouse', 'rose garden'] },
  { kind: 'treehouse', label: 'Treehouse', emoji: '🌲', words: ['treehouse', 'tree house'] },
  { kind: 'cafe', label: 'Café', emoji: '☕', words: ['cafe', 'coffee shop', 'coffee', 'starbucks', 'tea shop', 'boba', 'bubble tea'] },
  { kind: 'bakery', label: 'Bakery', emoji: '🥐', words: ['bakery', 'cake shop', 'donut shop', 'cupcake'] },
  { kind: 'icecream', label: 'Ice cream shop', emoji: '🍦', words: ['ice cream', 'ice cream shop', 'gelato', 'froyo'] },
  { kind: 'pizza', label: 'Pizza place', emoji: '🍕', words: ['pizza', 'pizzeria', 'restaurant', 'burger', 'mcdonalds', 'diner', 'sushi'] },
  { kind: 'library', label: 'Library', emoji: '📚', words: ['library', 'bookstore', 'book shop', 'bookshop'] },
  { kind: 'museum', label: 'Museum', emoji: '🏛️', words: ['museum', 'art gallery', 'gallery'] },
  { kind: 'stadium', label: 'Stadium', emoji: '🏟️', words: ['stadium', 'football field', 'soccer field', 'basketball court', 'tennis court', 'court', 'arena', 'nfl stadium'] },
  { kind: 'skatepark', label: 'Skate park', emoji: '🛹', words: ['skate park', 'skatepark', 'skateboard'] },
  { kind: 'shop', label: 'Shop', emoji: '🛍️', words: ['shop', 'store', 'mall', 'boutique', 'kpop store', 'candy shop', 'toy store'] },
  { kind: 'ship', label: 'Pirate ship', emoji: '🏴‍☠️', words: ['pirate ship', 'ship', 'boat', 'yacht'] },
  { kind: 'cinema', label: 'Cinema', emoji: '🎬', words: ['cinema', 'movie theater', 'movie theatre', 'theater', 'theatre'] },
  { kind: 'university', label: 'University', emoji: '🎓', words: ['university', 'universities', 'uni', 'college', 'colleges', 'campus'] },
  { kind: 'herotower', label: 'Kinsburg Tower', emoji: '🌟', words: ['avengers tower', 'avenger tower', 'stark tower', 'hero tower', 'kinsburg tower', 'avengers'] },
];

/** Kinds that belong in the neighbourhoods, never in the centre chunk or on the town square
 *  (src/city/sites.ts assignBuildSites): big campuses and venues. */
export const RESIDENTIAL_ONLY = ['university', 'stadium'];
export const BUILD_KINDS = BUILDS.map((b) => b.kind);
export const BUILD_BY_KIND = Object.fromEntries(BUILDS.map((b) => [b.kind, b]));

/** How many of the most-liked requests are built each day, and how long a request stays in the running. */
export const BUILDS_PER_DAY = 3;
export const REQUEST_DAYS = 7;
/** Days a bestie's plot is held. */
export const BESTIE_HOLD_DAYS = 7;

const clean = (text) => ` ${String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z]+/g, ' ').trim().replace(/([a-z])\1{2,}/g, '$1')} `;

// Phrases that turn a mention into a request ("build a pool", "we need a cafe", "pool please").
const ASK = / (build|add|make|put|bring|open|need|want|wanna|get|give|have|can we|can you|could we|could you|pls|please|plz) /;
const NEG = / (don t|dont|not|never|no more|hate|stop|remove|destroy|delete|burn) /;

/**
 * The build kind a comment asks for, or null. A bare one-word name ("pool!", "Castle 🏰") counts,
 * as does any request phrase plus a catalogue word. House requests ("I want a house") are MOVE IN,
 * not builds, and negative comments ("no more pools") never count.
 */
export function parseBuildRequest(text) {
  const t = clean(text);
  if (t.trim().length === 0 || NEG.test(t)) return null;
  const words = t.trim().split(' ');
  // The thing mentioned first wins ("Eiffel Tower with an infinity pool" is a tower); at the same
  // spot the longer phrase wins ("ice cream shop" over "shop").
  let best = null;
  for (const b of BUILDS) {
    for (const w of b.words) {
      const at = t.indexOf(` ${w} `);
      if (at >= 0 && (!best || at < best.at || (at === best.at && w.length > best.len))) best = { kind: b.kind, at, len: w.length };
    }
  }
  if (!best) return null;
  // Wish-style comments ("Eiffel Tower", "pirate ship in a lake") count when short; longer ones
  // need a request phrase ("can we get", "build", "please").
  if (words.length <= 8 || ASK.test(t)) return best.kind;
  return null;
}

/** The friend a MOVE IN comment brings ("MOVE IN @bestie", "move in with @sam"), or null. */
export function parseBestie(text, ownAccount = 'kinsburgtown') {
  const m = String(text ?? '').match(/@([A-Za-z0-9._]{1,30})/);
  if (!m) return null;
  const h = m[1].toLowerCase().replace(/\.+$/, '');
  if (!h || h === String(ownAccount).toLowerCase() || /\.\./.test(h) || h.startsWith('.')) return null;
  return h;
}
