// The daily Reel "series": what the on-video title says and how the caption reads.
// Wording follows docs/launch-content.md (§4 "Lights on" series, §5 caption sets).
// Edit freely — each series is plain text + a few numbers from the live city.
//
// Rules the caption must keep (Instagram + our own content plan):
//   • ≤ 2,200 characters, ≤ 5 hashtags (we use 3–5 as topic labels).
//   • The MOVE IN call to action lives in the caption, never burned into the video.
//   • New residents appear as plain names (no @-tags), at most a few.
//   • No engagement bait: no "like to vote", no countdowns, no "tag 3 friends".

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

/** @typedef {{ day:number, residents:number, newToday:number, names:string[], street:string|null, city:string }} CaptionStats */

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

export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 5;

/** Build the final caption text and check Instagram's limits. */
export function buildCaption(seriesId, stats) {
  const series = SERIES[seriesId];
  if (!series) throw new Error(`Unknown series "${seriesId}". Known: ${Object.keys(SERIES).join(', ')}`);
  const body = series.caption(stats).filter(Boolean).join(' ');
  const tags = series.hashtags.slice(0, MAX_HASHTAGS);
  let text = `${body}\n\n${tags.join(' ')}`;
  if (text.length > MAX_CAPTION) text = text.slice(0, MAX_CAPTION - 1) + '…';
  const hashCount = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashCount > MAX_HASHTAGS) throw new Error(`Caption has ${hashCount} hashtags (max ${MAX_HASHTAGS})`);
  return text;
}
