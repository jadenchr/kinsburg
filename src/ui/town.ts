// Town hall panel: how to move in, the mayor, the current vote, how houses grow, the founders,
// supporting the city (perks) and the policy pages. Opened from the "Town hall" button.
import type { CityData, Resident } from '../types';
import type { PerkKey, TownInfo, TownPoll } from '../data/town';
import { ICONS } from './icons';

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

export type TownSection = 'move-in' | 'vote' | 'support';

export interface TownPanel {
  readonly dialog: HTMLDialogElement;
  update(town: TownInfo, data: CityData): void;
  open(section?: TownSection): void;
  close(): void;
  onClosed(cb: () => void): void;
}

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
      p.status === 'open'
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

  function section(id: TownSection | 'mayor' | 'grow' | 'founders', heading: string, ...kids: Node[]) {
    const s = el('section', { class: 'kb-town-section', id: `kb-town-${id}`, 'aria-labelledby': `kb-town-${id}-h` });
    s.append(el('h3', { id: `kb-town-${id}-h` }, heading), ...kids);
    return s;
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

    // mayor
    const mayorText = t.mayor ? el('p', {}, el('b', {}, `@${t.mayor.handle}`), ` has been mayor since Day ${t.mayor.sinceDay.toLocaleString()}.`) : el('p', {}, 'Kinsburg has no mayor yet. The first election is coming soon.');
    body.append(section('mayor', 'Mayor', mayorText));

    // votes
    if (t.polls.length) body.append(section('vote', 'Town vote', ...t.polls.map((p) => pollBlock(p, t.account))));

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
  };
}
