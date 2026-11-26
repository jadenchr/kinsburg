// Seasons: the Christmas look (snow, fairy lights, the town-square tree, Santa's sleigh) is on from
// 26 November through 6 January by the viewer's own calendar, then switches itself off.
//
//   ?season=christmas   force it on (testing, reels)
//   ?season=off         force it off

/** 26 Nov – 6 Jan, inclusive, by the date's local calendar day. */
export function isChristmas(date: Date): boolean {
  const m = date.getMonth(); // 0 = Jan
  const d = date.getDate();
  return (m === 10 && d >= 26) || m === 11 || (m === 0 && d <= 6);
}

let cached: boolean | null = null;

/** Is the Christmas look on for this page load? The URL override wins over the date. */
export function christmasOn(): boolean {
  if (cached !== null) return cached;
  let on = isChristmas(new Date());
  try {
    const v = new URLSearchParams(location.search).get('season');
    if (v === 'christmas' || v === 'xmas') on = true;
    else if (v === 'off' || v === 'none') on = false;
  } catch {
    /* no location (tests): the date decides */
  }
  cached = on;
  return on;
}
