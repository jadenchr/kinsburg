// Town hall panel: how to move in, the mayor, the current vote, how houses grow, the founders,
// supporting the city (perks) and the policy pages. Opened from the "Town hall" button.
import type { CityData, Resident } from '../types';
import type { PerkKey, TownIncident, TownInfo, TownPoll, TownPolitics } from '../data/town';
import { ICONS } from './icons';
import { addressOf } from './lookup';
import { COINS, INCIDENTS, PET_COIN_PRICE } from '../../shared/sim.mjs';
import { TERM_DAYS } from '../../shared/politics.mjs';

/** What each perk is, in the words shown to people. Cosmetic only, never power. */
export const PERK_INFO: { key: PerkKey; name: string; what: string }[] = [
  { key: 'star', name: 'Gold star', what: 'A gold star floats above your house.' },
  { key: 'goldRoof', name: 'Golden roof', what: 'Your roof turns gold.' },
  { key: 'monument', name: 'Founders Monument', what: 'Your name on the monument in the park, and a Founder badge.' },
  { key: 'street', name: 'Name a street', what: 'A street named by you, and a Founder badge.' },
  { key: 'poster', name: 'City poster', what: 'A printed poster of Kinsburg with your house circled.' },
];

/**
 * Stripe Payment Link with the buyer's handle attached. Stripe only allows letters, digits, "-"
 * and "_" in client_reference_id, so dots travel as "-" (the Worker turns them back).
 */
export function buyUrl(url: string, handle?: string): string {
  if (!handle) return url;
  const u = new URL(url);
  u.searchParams.set('client_reference_id', handle.replace(/\./g, '-'));
  return u.toString();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return n;
}
const html = (s: string) => {
  const t = document.createElement('template');
  t.innerHTML = s;
  return t.content;
};

export type TownSection = 'move-in' | 'status' | 'vote' | 'support';

export interface TownPanel {
  readonly dialog: HTMLDialogElement;
  update(town: TownInfo, data: CityData): void;
  open(section?: TownSection): void;
  close(): void;
  onClosed(cb: () => void): void;
  /** a resident's @ was chosen: show their house */
  onSelect(cb: (handle: string) => void): void;
}

const STAT_ROWS = [
  { key: 'health', label: 'Health' },
  { key: 'safety', label: 'Safety' },
  { key: 'education', label: 'Education' },
  { key: 'happiness', label: 'Happiness' },
] as const;

/** A word for a stat so the level never rests on colour alone. */
export function statWord(n: number): string {
  return n >= 75 ? 'Good' : n >= 50 ? 'Fair' : n >= 30 ? 'Low' : 'Needs help';
}

/** "Fair" etc. for the mayor's approval, same words as the stats. */
export const approvalWord = statWord;

/** "in 2 days", "in 5 hours", "within the hour" */
export function closesIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 3_600_000)) return 'within the hour';
  const h = Math.round(ms / 3_600_000);
  if (h < 36) return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.round(ms / 86_400_000);
  return `in ${d} ${d === 1 ? 'day' : 'days'}`;
}

const lower = (s: string) => s.toLowerCase();
const pluralJob = (job: string, n: number) => (n === 1 ? lower(job) : job === 'Police officer' ? 'police officers' : lower(job) + 's');

/** "firefighters", "doctors or nurses" */
export function jobsText(kind: TownIncident['kind'], n = 2): string {
  const jobs = INCIDENTS[kind].jobs.map((j) => pluralJob(j, n));
  return jobs.length > 1 ? `${jobs.slice(0, -1).join(', ')} or ${jobs[jobs.length - 1]}` : jobs[0]!;
}

/** "2 of 3 firefighters" / "1 of 3 doctors or nurses" */
export function progressText(inc: TownIncident): string {
  const have = Math.min(inc.responders.length, inc.needed);
  return `${have} of ${inc.needed} ${jobsText(inc.kind, inc.needed)}`;
}

/** "at 12 Larkspur Lane", or the town-wide place. */
export function whereText(inc: TownIncident, data: CityData): string {
  const r = inc.target ? data.residents.find((x) => x.handle === inc.target) : undefined;
  const addr = r ? addressOf(r, data) : '';
  if (addr) return `at ${addr}`;
  if (inc.kind === 'flu') return 'at Kinsburg General Hospital';
  if (inc.kind === 'exam') return 'at Kinsburg Elementary';
  return inc.target ? `at @${inc.target}'s house` : 'around town';
}

/** "2 h left", "40 min left", "time is nearly up" */
export function timeLeft(inc: TownIncident, now = Date.now()): string {
  const ms = Date.parse(inc.deadline) - now;
  if (!(ms > 60_000)) return 'nearly out of time';
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} min left`;
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}

const handles = (hs: string[]) => {
  const t = hs.map((h) => `@${h}`);
  return t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}` : (t[0] ?? '');
};

function pollBlock(p: TownPoll, account: string): HTMLElement {
  const box = el('div', { class: 'kb-poll' });
  box.append(el('p', { class: 'kb-poll-q' }, p.question));
  const list = el('ul', { class: 'kb-poll-options' });
  const max = Math.max(1, ...p.options.map((o) => o.votes));
  for (const o of p.options) {
    const pct = p.total ? Math.round((o.votes / p.total) * 100) : 0;
    const won = p.result?.winner === o.key;
    const li = el('li', { class: 'kb-poll-option' + (won ? ' kb-poll-won' : '') });
    const label = el('span', { class: 'kb-poll-label' }, el('b', {}, o.key), ' ', o.label);
    const count = el('span', { class: 'kb-poll-count' }, `${o.votes.toLocaleString()} ${o.votes === 1 ? 'vote' : 'votes'}`);
    const bar = el('span', { class: 'kb-poll-bar', 'aria-hidden': 'true' });
    bar.style.setProperty('--w', `${(o.votes / max) * 100}%`);
    li.append(label, count, bar, el('span', { class: 'kb-vh' }, `${pct} percent`));
    list.append(li);
  }
  box.append(list);
  const when = new Date(p.closesAt);
  const whenText = when.toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  box.append(
    el(
      'p',
      { class: 'kb-town-note' },
      p.status === 'open' && p.anywhere
        ? `Comment VOTE and their @ on any post by @${account}, for example VOTE @${p.options[0]?.key ?? 'name'}. One vote each, until ${whenText}.`
        : p.status === 'open'
        ? `Residents vote by commenting the letter on our latest vote post on @${account}. One vote each, until ${whenText}.`
        : p.result?.label
          ? `Closed. ${p.kind === 'election' ? 'New mayor' : 'Kinsburg chose'}: ${p.result.label}.`
          : 'Closed with no votes.',
    ),
  );
  return box;
}

export function createTownPanel(): TownPanel {
  const dialog = el('dialog', { class: 'kb-panel kb-town', 'aria-labelledby': 'kb-town-title' });
  const head = el('div', { class: 'kb-card-head' });
  const title = el('h2', { id: 'kb-town-title', class: 'kb-card-title', tabindex: '-1' }, 'Town hall');
  const close = el('button', { type: 'button', class: 'kb-icon-btn', 'aria-label': 'Close' });
  close.append(html(ICONS.close));
  head.append(title, close);
  const body = el('div', { class: 'kb-town-body' });
  dialog.append(head, body);

  let town: TownInfo | null = null;
  let data: CityData | null = null;
  const closedCbs: (() => void)[] = [];
  const selectCbs: ((handle: string) => void)[] = [];

  function section(id: TownSection | 'mayor' | 'grow' | 'founders' | 'life', heading: string, ...kids: Node[]) {
    const s = el('section', { class: 'kb-town-section', id: `kb-town-${id}`, 'aria-labelledby': `kb-town-${id}-h` });
    s.append(el('h3', { id: `kb-town-${id}-h` }, heading), ...kids);
    return s;
  }

  function statusSection(t: TownInfo, d: CityData): HTMLElement {
    const sim = t.sim!;
    const kids: Node[] = [];

    const bars = el('ul', { class: 'kb-poll-options kb-stats-list' });
    for (const row of STAT_ROWS) {
      const v = Math.round(sim.stats[row.key]);
      const low = v < 50;
      const li = el('li', { class: 'kb-poll-option kb-stat' + (low ? ' kb-stat-low' : '') });
      li.append(
        el('span', { class: 'kb-poll-label' }, row.label),
        el('span', { class: 'kb-poll-count' }, `${v} · ${statWord(v)}`),
      );
      const bar = el('span', { class: 'kb-poll-bar', 'aria-hidden': 'true' });
      bar.style.setProperty('--w', `${v}%`);
      li.append(bar, el('span', { class: 'kb-vh' }, `${row.label}: ${v} out of 100, ${statWord(v)}`));
      bars.append(li);
    }
    kids.push(bars, el('p', { class: 'kb-treasury' }, el('b', {}, 'Treasury: '), `${sim.treasury.toLocaleString()} town coins`));

    kids.push(el('h4', { class: 'kb-town-sub' }, 'Happening now'));
    if (!sim.open.length) kids.push(el('p', {}, 'All quiet in Kinsburg.'));
    else {
      const list = el('ul', { class: 'kb-incidents' });
      for (const inc of sim.open) {
        const li = el('li', { class: 'kb-incident' });
        li.append(
          el('b', {}, inc.label),
          ' ',
          whereText(inc, d),
          el('span', { class: 'kb-town-note' }, `${progressText(inc)} so far · ${timeLeft(inc)}`),
        );
        if (inc.responders.length) li.append(el('span', { class: 'kb-town-note' }, `Responding: ${handles(inc.responders)}`));
        const jobs = jobsText(inc.kind);
        li.append(el('span', { class: 'kb-town-note' }, `${jobs[0]!.toUpperCase()}${jobs.slice(1)}: comment `, el('b', {}, 'RESPOND'), ' on any post.'));
        list.append(li);
      }
      kids.push(list);
    }

    const titles = sim.ofTheWeek.filter((x) => x.title && x.handle);
    const recent = sim.recent.filter((x) => x.status !== 'open').slice(0, 5);
    kids.push(el('h4', { class: 'kb-town-sub' }, 'Heroes'));
    if (!titles.length && !recent.length) kids.push(el('p', {}, 'Nobody yet. The first responders will be listed here.'));
    if (titles.length) {
      const l = el('ul', { class: 'kb-incidents' });
      for (const x of titles) l.append(el('li', {}, el('b', {}, x.title), `: @${x.handle}`, el('span', { class: 'kb-town-note' }, `${x.count} ${x.count === 1 ? 'call' : 'calls'} answered this week`)));
      kids.push(l);
    }
    if (recent.length) {
      const l = el('ul', { class: 'kb-incidents' });
      for (const inc of recent) {
        const place = whereText(inc, d).replace(/^at /, 'on ');
        const what = `${inc.label} ${place}`;
        l.append(el('li', {}, inc.status === 'resolved' && inc.responders.length ? `${what}: handled by ${handles(inc.responders)}` : inc.status === 'resolved' ? `${what}: handled` : `${what}: went unanswered`));
      }
      kids.push(l);
    }
    return section('status', 'City status', ...kids);
  }

  /** @handle as a button that shows their house, like the staff names on building cards */
  function handleButton(h: string) {
    const btn = el('button', { type: 'button', class: 'kb-handle-btn' }, `@${h}`);
    btn.addEventListener('click', () => selectCbs.forEach((cb) => cb(h)));
    return btn;
  }
  function handleList(hs: string[], label: string) {
    const ul = el('ul', { class: 'kb-handle-list', 'aria-label': label });
    for (const h of hs) ul.append(el('li', {}, handleButton(h)));
    return ul;
  }

  function mayorSection(t: TownInfo): HTMLElement {
    const pol: TownPolitics | undefined = t.politics;
    const m = pol?.mayor ?? (t.mayor ? { handle: t.mayor.handle, sinceDay: t.mayor.sinceDay, termEndsDay: t.mayor.sinceDay + TERM_DAYS, approval: null } : null);
    const kids: Node[] = [];
    const cmd = (c: string) => el('b', {}, c);
    const ig = `@${t.account}`;
    if (m) {
      kids.push(el('h4', { class: 'kb-town-sub' }, 'The mayor'));
      kids.push(el('p', { class: 'kb-mayor-name' }, el('span', { class: 'kb-mayor-badge' }, html(ICONS.crown), 'Mayor '), handleButton(m.handle)));
      kids.push(el('p', {}, `Mayor since Day ${m.sinceDay.toLocaleString()} · term ends Day ${m.termEndsDay.toLocaleString()}`));
      if (typeof m.approval === 'number') {
        const v = Math.round(m.approval);
        const ul = el('ul', { class: 'kb-poll-options kb-stats-list' });
        const li = el('li', { class: 'kb-poll-option kb-stat' + (v < 50 ? ' kb-stat-low' : '') });
        li.append(el('span', { class: 'kb-poll-label' }, 'Approval'), el('span', { class: 'kb-poll-count' }, `${v} · ${approvalWord(v)}`));
        const bar = el('span', { class: 'kb-poll-bar', 'aria-hidden': 'true' });
        bar.style.setProperty('--w', `${v}%`);
        li.append(bar, el('span', { class: 'kb-vh' }, `Approval: ${v} out of 100, ${approvalWord(v)}`));
        ul.append(li);
        kids.push(ul, el('p', { class: 'kb-town-note' }, 'The average of the four city stats, minus the share of this week\u2019s active residents who protest.'));
      }
      if (pol) {
        kids.push(el('h4', { class: 'kb-town-sub' }, 'What the mayor can do'));
        const stat = t.sim ? ` Treasury today: ${t.sim.treasury.toLocaleString()} town coins.` : '';
        kids.push(
          el('p', {}, 'Once a day the mayor can comment ', cmd('FUND HEALTH'), ', ', cmd('FUND SAFETY'), ', ', cmd('FUND EDUCATION'), ' or ', cmd('FUND PARKS'), ` on any post. Each one spends ${pol.fund.cost.toLocaleString()} town coins from the treasury and raises that stat by ${pol.fund.boost}.${stat}`),
        );
      }
    } else {
      kids.push(el('p', {}, 'Kinsburg has no mayor yet.'));
      if (!pol?.election) kids.push(el('p', {}, 'Elections start by themselves. Nominations open for 3 days, then the whole town votes for 2 days. A mayor serves two weeks.'));
    }
    const e = pol?.election;
    if (e) {
      kids.push(el('h4', { class: 'kb-town-sub' }, e.recall ? 'Recall election' : 'Election'));
      if (e.recall) kids.push(el('p', {}, 'Enough residents protested, so Kinsburg is choosing a mayor again. The mayor may run again.'));
      if (e.phase === 'nominations') {
        kids.push(el('p', {}, el('b', {}, `Nominations close ${closesIn(e.nominationsCloseAt)}.`), ' Then the town votes for 2 days.'));
        if (e.candidates.length) kids.push(el('p', { class: 'kb-town-note' }, 'Running so far:'), handleList(e.candidates, 'Candidates so far'));
        else kids.push(el('p', { class: 'kb-town-note' }, 'Nobody is running yet.'));
        kids.push(el('p', {}, 'Want the job? Comment ', cmd('RUN FOR MAYOR'), ` on any post by ${ig}. Up to 6 can run.`));
      } else {
        const poll = t.polls.find((p) => p.id === e.pollId);
        kids.push(el('p', {}, el('b', {}, 'Voting is open.'), ' One vote each.'));
        if (poll) kids.push(pollBlock(poll, t.account));
        else if (e.candidates.length) kids.push(handleList(e.candidates, 'Candidates'));
      }
    }
    const pr = pol?.protest;
    if (pr && m) {
      kids.push(el('h4', { class: 'kb-town-sub' }, 'Protests'));
      const need = Math.max(1, pr.threshold);
      const shown = Math.min(pr.count, need);
      const ul = el('ul', { class: 'kb-poll-options kb-stats-list' });
      const li = el('li', { class: 'kb-poll-option' });
      li.append(el('span', { class: 'kb-poll-label' }, `${pr.count.toLocaleString()} of ${need.toLocaleString()} protesters needed for a recall`), el('span', { class: 'kb-poll-count' }, `${Math.round((shown / need) * 100)}%`));
      const bar = el('span', { class: 'kb-poll-bar', 'aria-hidden': 'true' });
      bar.style.setProperty('--w', `${(shown / need) * 100}%`);
      li.append(bar);
      ul.append(li);
      kids.push(ul);
      kids.push(el('p', { class: 'kb-town-note' }, `Counted over 7 days, from ${pr.active.toLocaleString()} residents active this week. At the threshold a recall election starts at once.`));
      if (pr.recent.length) kids.push(el('p', { class: 'kb-town-note' }, 'Recent protesters:'), handleList(pr.recent.slice(0, 12), 'Recent protesters'));
      kids.push(el('p', {}, 'Not happy with the mayor? Comment ', cmd('PROTEST'), ' on any post. One per person per term.'));
    }
    return section('mayor', 'Mayor', ...kids);
  }

  function render() {
    if (!town || !data) return;
    const t = town;
    const ig = `https://instagram.com/${t.account}`;
    const link = (href: string, text: string) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
    body.replaceChildren();

    // how to move in
    const steps = el('ol', { class: 'kb-steps' });
    steps.append(
      el('li', {}, 'Comment ', el('b', {}, 'MOVE IN'), ' on any post by ', link(ig, `@${t.account}`), ', or send it to us as a message.'),
      el('li', {}, 'Within 15 minutes you get a house, a street address and a job.'),
      el('li', {}, 'Search your @ on this map and share your resident card.'),
    );
    body.append(
      section('move-in', 'How to move in', steps, el('p', { class: 'kb-town-note' }, 'Houses are free. Following us is not required, but it is how you will see your house grow.')),
    );


    // city status
    if (t.sim) body.append(statusSection(t, data!));

    // jobs and pets
    const cmd = (c: string) => el('b', {}, c);
    body.append(
      section(
        'life',
        'Jobs and pets',
        el('p', {}, 'Pick your job by commenting ', cmd('JOB'), ' and the job on any post, for example ', cmd('JOB DOCTOR'), ', ', cmd('JOB POLICE'), ', ', cmd('JOB FIREFIGHTER'), ', ', cmd('JOB TEACHER'), ' or ', cmd('JOB VET'), '. You can change it once a week. Tap the hospital, school, KPD or KFD to see who works there.'),
        el('p', {}, 'When something happens in town, residents with the right job comment ', cmd('RESPOND'), ' on any post by @', t.account, '. Each responder earns ', `${COINS.respond} town coins`, ' (carpenters ', `${COINS.repair}`, ' for repairs). With nothing to answer, ', cmd('RESPOND'), ` is a paid shift: ${COINS.duty} coins, once a day.`),
        el('p', {}, 'Get a pet for your yard: comment ', cmd('PET DOG'), ', ', cmd('PET CAT'), ' or ', cmd('PET BUNNY'), '. Free. Rare pets (fox, owl, golden retriever) cost ' + PET_COIN_PRICE + ' town coins: ', cmd('PET FOX'), ', ', cmd('PET OWL'), ' or ', cmd('PET GOLDEN'), '. Town coins are pretend money. They are never sold and never paid out.'),
        el('p', { class: 'kb-town-note' }, 'New here? One comment does it all: MOVE IN JOB DOCTOR PET DOG.'),
      ),
    );

    // mayor, elections and protests
    body.append(mayorSection(t));

    // votes (an automatic election's poll is shown with the election above)
    const electionPoll = t.politics?.election?.pollId;
    const polls = t.polls.filter((p) => !(electionPoll && p.id === electionPoll));
    if (polls.length) body.append(section('vote', 'Town vote', ...polls.map((p) => pollBlock(p, t.account))));

    // grow
    const [a, b, c] = t.levelAt;
    body.append(
      section(
        'grow',
        'Grow your house',
        el('p', {}, `Every comment you leave on our posts counts toward your house. ${a} comments add a second storey, ${b} a third and ${c} a fourth.`),
      ),
    );

    // founders
    const founders = data.residents.filter((r: Resident) => r.perks.includes('monument') || r.perks.includes('street'));
    if (founders.length) {
      const list = el('ul', { class: 'kb-founders' });
      for (const f of founders.slice(0, 60)) list.append(el('li', {}, `@${f.handle}`));
      const more = founders.length > 60 ? [el('p', { class: 'kb-town-note' }, `and ${(founders.length - 60).toLocaleString()} more on the monument.`)] : [];
      body.append(section('founders', 'Founders', el('p', {}, 'The people whose names are on the Founders Monument and on our streets.'), list, ...more));
    }

    // support
    const perks = el('ul', { class: 'kb-shop' });
    for (const p of PERK_INFO) {
      const l = t.perkLinks[p.key];
      const li = el('li', { class: 'kb-shop-item' });
      li.append(el('div', {}, el('b', {}, p.name), el('span', { class: 'kb-town-note' }, p.what)));
      if (l) li.append(el('a', { class: 'kb-btn kb-btn-secondary', href: l.url, target: '_blank', rel: 'noopener' }, l.price ? `Buy for ${l.price}` : 'Buy'));
      else li.append(el('span', { class: 'kb-shop-soon' }, 'Opens soon'));
      perks.append(li);
    }
    body.append(
      section(
        'support',
        'Support Kinsburg',
        el('p', {}, 'Perks are just for looks. They never buy votes, a bigger house or a better job. Your money keeps the city online.'),
        perks,
      ),
    );

    if (t.sponsors.length) {
      body.append(el('p', { class: 'kb-town-note' }, 'Want a billboard on the town square? Message ', link(ig, `@${t.account}`), '.'));
    }

    const nav = el('nav', { class: 'kb-town-links', 'aria-label': 'Policies' });
    nav.append(el('a', { href: '/privacy/' }, 'Privacy'), el('a', { href: '/terms/' }, 'Terms'), el('a', { href: '/refunds/' }, 'Refunds'));
    body.append(nav);
  }

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => closedCbs.forEach((cb) => cb()));

  return {
    dialog,
    update(t, d) {
      town = t;
      data = d;
      render();
    },
    open(sec) {
      render();
      if (!dialog.open) dialog.show();
      const target = sec ? body.querySelector<HTMLElement>(`#kb-town-${sec}`) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      else body.scrollTop = 0;
      title.focus({ preventScroll: true });
    },
    close() {
      if (dialog.open) dialog.close();
    },
    onClosed(cb) {
      closedCbs.push(cb);
    },
    onSelect(cb) {
      selectCbs.push(cb);
    },
  };
}
