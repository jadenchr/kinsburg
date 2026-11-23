// The daily Reel "series": what the on-video title says and how the caption reads.
// Wording follows docs/launch-content.md (§4 "Lights on" series, §5 caption sets).
// Edit freely — each series is plain text + a few numbers from the live city.
//
// Rules the caption must keep (Instagram + our own content plan):
//   • ≤ 2,200 characters, ≤ 5 hashtags (we use 3–5 as topic labels).
//   • The MOVE IN call to action lives in the caption, never burned into the video.
//   • New residents appear as plain names (no @-tags), at most a few.
//   • Hero shout-outs (resolved incidents, see heroLines) name responders as plain names too.
//   • No engagement bait: no "like to vote", no countdowns, no "tag 3 friends".

import { INCIDENTS } from '../../shared/sim.mjs';

const n = (x) => Number(x).toLocaleString('en-US');

/** "a", "a and b", "a, b and c", "a, b, c and 12 more" */
export function nameList(names, total, max = 3) {
  const shown = names.slice(0, max);
  const rest = Math.max(0, total - shown.length);
  if (!shown.length) return '';
  if (rest > 0) return `${shown.join(', ')} and ${n(rest)} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** @typedef {{ day:number, residents:number, newToday:number, names:string[], street:string|null, city:string, newest?: { handle:string, job:string, street:string|null, number:number } | null }} CaptionStats */

export const SERIES = {
  /** default: the nightly dusk-to-night time-lapse */
  'lights-on': {
    title: (s) => `Lights on · night ${s.day}`,
    subtitle: (s) => (s.newToday > 0 ? `${n(s.residents)} residents · +${n(s.newToday)} moved in today` : `${n(s.residents)} residents`),
    caption: (s) => [
      `Lights on, night ${s.day}. ${n(s.residents)} ${s.residents === 1 ? 'person lives' : 'people live'} in ${s.city} now` +
        (s.newToday > 0 ? `, and ${n(s.newToday)} moved in today.` : '.'),
      s.street ? `Newest street: ${s.street}.` : '',
      s.names.length ? `Welcome to our newest ${s.newToday === 1 ? 'neighbour' : 'neighbours'}: ${nameList(s.names, s.newToday)}.` : '',
      'Want a window of your own? Comment MOVE IN.',
    ],
    hashtags: ['#cozygames', '#citybuilder', '#nightcity', '#indiegame'],
  },

  /** the plain "Day N" progress post */
  day: {
    title: (s) => `Day ${s.day} in ${s.city}`,
    subtitle: (s) => (s.newToday > 0 ? `+${n(s.newToday)} new ${s.newToday === 1 ? 'neighbour' : 'neighbours'} · ${n(s.residents)} residents` : `${n(s.residents)} residents`),
    caption: (s) => [
      `Day ${s.day} in ${s.city}, a live city where every follower gets a house.`,
      s.newToday > 0 ? `${n(s.newToday)} moved in today, so ${n(s.residents)} people live here now.` : `${n(s.residents)} people live here now.`,
      s.names.length ? `Say hi to ${nameList(s.names, s.newToday)}.` : '',
      'Comment MOVE IN and the city builds yours: a street address, a job and a resident card to post. Link in bio.',
    ],
    hashtags: ['#citybuilder', '#cozygames', '#browsergame', '#indiegame', '#gamedev'],
  },
};

// A new face every week: "resident of the day" puts one newcomer centre stage.
SERIES['resident-of-the-day'] = {
  title: () => 'Resident of the day',
  subtitle: (s) => (s.newest ? `${s.newest.handle}, ${s.newest.job.toLowerCase()}` : `${n(s.residents)} residents`),
  caption: (s) => [
    s.newest
      ? `Meet ${s.newest.handle}, resident #${n(s.newest.number)} of ${s.city}. ${article(s.newest.job)} ${s.newest.job.toLowerCase()}${s.newest.street ? ` on ${s.newest.street}` : ''}.`
      : `Meet the newest neighbours of ${s.city}.`,
    `${n(s.residents)} people live here now. Every house belongs to a real person.`,
    'Want to be next? Comment MOVE IN and the city builds your house tonight.',
  ],
  hashtags: ['#citybuilder', '#cozygames', '#indiegame', '#community'],
};

// When the city grows into a new street, it gets its own post.
SERIES['new-street'] = {
  title: (s) => (s.street ? `New street: ${s.street}` : `Day ${s.day} in ${s.city}`),
  subtitle: (s) => (s.newToday > 0 ? `+${n(s.newToday)} new ${s.newToday === 1 ? 'neighbour' : 'neighbours'}` : `${n(s.residents)} residents`),
  caption: (s) => [
    s.street ? `${s.city} grew a new street today: ${s.street}.` : `Day ${s.day} in ${s.city}.`,
    s.names.length ? `First to move in: ${nameList(s.names, s.newToday)}.` : '',
    'Comment MOVE IN for a house of your own.',
  ],
  hashtags: ['#citybuilder', '#cozygames', '#pixelcity', '#indiegame'],
};

const HERO_WINDOW_MS = 26 * 3600_000;
const place = (t) => (t ? ` at ${t}'s house` : '');
const HERO_TEXT = {
  fire: (w, who, t) => `${w} KFD ${who} put out a kitchen fire${place(t)} 🚒`,
  burglary: (w, who, t) => `${w} officers ${who} stopped a break-in${place(t)} 🚓`,
  crash: (w, who, t) => `${w} ${who} cleared a fender-bender${place(t)} 🚗`,
  flu: (w, who, _t, city) => `${w} ${who} got ${city} through flu week 🩺`,
  lostpet: (w, who, t) => `${w} ${who} found a lost pet${place(t)} 🐾`,
  exam: (w, who, _t, city) => `${w} ${who} got ${city} through exam week 📚`,
  repair: (w, who, t) => `${w} ${who} repaired the storm damage${place(t)} 🔨`,
};

/** Incidents resolved in the last ~26 h, newest first (empty if town data is missing or old-format). */
export function recentHeroes(sim, now = Date.now()) {
  const list = Array.isArray(sim?.recent) ? sim.recent : [];
  return list
    .filter((i) => i && i.status === 'resolved' && i.closedAt && HERO_TEXT[i.kind] && Array.isArray(i.responders) && i.responders.length)
    .filter((i) => now - Date.parse(i.closedAt) <= HERO_WINDOW_MS && Date.parse(i.closedAt) <= now + 3600_000)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
}

/** One or two short shout-out lines, one per incident kind (the newest of each kind). */
export function heroLines(sim, city = 'Kinsburg', now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const i of recentHeroes(sim, now)) {
    if (seen.has(i.kind) || out.length >= 2) continue;
    seen.add(i.kind);
    const when = now - Date.parse(i.closedAt) < 10 * 3600_000 ? 'Today' : 'Last night';
    out.push(HERO_TEXT[i.kind](when, nameList(i.responders, i.responders.length), i.target, city) + '.');
  }
  return out;
}

/** "Right now: a break-in at x's house needs 2 more police officers. Comment RESPOND." or ''. */
export function openCall(sim, now = Date.now()) {
  const open = (Array.isArray(sim?.open) ? sim.open : [])
    .filter((i) => i && i.status === 'open' && INCIDENTS[i.kind] && Date.parse(i.deadline) > now)
    .map((i) => ({ i, left: i.needed - (i.responders?.length ?? 0) }))
    .filter((x) => x.left > 0)
    .sort((a, b) => Date.parse(a.i.deadline) - Date.parse(b.i.deadline));
  if (!open.length) return '';
  const { i, left } = open[0];
  const def = INCIDENTS[i.kind];
  const jobs = def.jobs.map((j) => j.toLowerCase() + 's');
  const who = jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} or ${jobs[jobs.length - 1]}` : jobs[0];
  const what = i.label.toLowerCase();
  return `Right now: ${article(what).toLowerCase()} ${what}${place(i.target)} needs ${left} more ${left === 1 ? who.replace(/s$/, '') : who}. Comment RESPOND.`;
}

/** Lines to slot in above the MOVE IN line; empty when there is no town data. */
export function simLines(sim, city, now = Date.now()) {
  if (!sim || typeof sim !== 'object' || !(Array.isArray(sim.recent) || Array.isArray(sim.open))) return [];
  return [...heroLines(sim, city, now), 'Firefighters, police, doctors: comment RESPOND when the city needs you.', openCall(sim, now)].filter(Boolean);
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'An' : 'A');

/**
 * Which series runs on a given day when none is chosen: mostly the nightly "Lights on", with
 * a progress post, a resident of the day and a new-street post spread through the week.
 */
// The evening Reel: what the city built today from comment requests (worker/src/builds.ts).
// stats.builds = [{ label, emoji, by }] built today; by = plain name of who asked first.
// Never "like to vote": the caption asks for ideas in the comments, nothing else.
SERIES['built-today'] = {
  title: (s) => `Built today · day ${s.day}`,
  subtitle: (s) => (s.builds?.length ? s.builds.map((b) => `${b.emoji} ${b.label}`).slice(0, 3).join('  ') : `${n(s.residents)} residents`),
  caption: (s) => {
    const built = s.builds ?? [];
    const lines = [
      built.length === 1
        ? `Day ${s.day} in ${s.city}: you asked for a ${built[0].label.toLowerCase()}, so we built one.`
        : `Day ${s.day} in ${s.city}: you asked, we built ${built.length} things.`,
      ...built.slice(0, 4).map((b) => `${b.emoji} ${b.label}, first asked for by ${b.by}.`),
      'What should we build next? Tell us in the comments: the favourite ideas get built tomorrow.',
      'Bringing a bestie? Comment MOVE IN @their_name and we save the house next door for 7 days.',
      'Want a house of your own? Comment MOVE IN.',
    ];
    return lines;
  },
  hashtags: ['#citybuilder', '#cozygames', '#youaskedwebuilt', '#indiegame'],
};

export function seriesForDate(isoDate) {
  const weekday = new Date(isoDate + 'T12:00:00Z').getUTCDay(); // 0 Sunday
  return ['day', 'lights-on', 'day', 'resident-of-the-day', 'lights-on', 'new-street', 'lights-on'][weekday];
}

export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 5;

/** Build the final caption text and check Instagram's limits. */
export function buildCaption(seriesId, stats, sim = null, now = Date.now()) {
  const series = SERIES[seriesId];
  if (!series) throw new Error(`Unknown series "${seriesId}". Known: ${Object.keys(SERIES).join(', ')}`);
  const lines = series.caption(stats).filter(Boolean);
  // shout-outs go above the closing MOVE IN line, which stays last
  const extra = simLines(sim, stats.city, now);
  if (extra.length) lines.splice(Math.max(0, lines.length - 1), 0, ...extra);
  const body = lines.join(' ');
  const tags = series.hashtags.slice(0, MAX_HASHTAGS);
  let text = `${body}\n\n${tags.join(' ')}`;
  if (text.length > MAX_CAPTION) text = text.slice(0, MAX_CAPTION - 1) + '…';
  const hashCount = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashCount > MAX_HASHTAGS) throw new Error(`Caption has ${hashCount} hashtags (max ${MAX_HASHTAGS})`);
  return text;
}
