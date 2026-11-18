// Kinsburg page UI: top bar, search, not-found note, resident card, splash.
// Everything is styled through the CSS variables main.ts sets from the sky.
import './ui.css';
import type { CreateUI, AppUI, CityStats } from './api';
import type { CityData, Resident } from '../types';
import { FONTS, skyAt, type SkyState } from '../theme';
import { ICONS } from './icons';
import { addressOf } from './lookup';
import { renderShareCard, shareOrDownload } from './share';
import { buyUrl, createTownPanel } from './town';
import type { TownInfo } from '../data/town';
import type { BuildingRef } from '../city/api';
import { PET_NAMES } from '../../shared/residents-format.mjs';
import { SERVICE_STAFF } from '../../shared/city-layout.mjs';

/** How each building is described, and the comment that gets you a job there. */
const BUILDING_COPY: Record<Exclude<BuildingRef['kind'], 'townhall'>, { what: string; command: string }> = {
  hospital: { what: 'Hospital', command: 'JOB DOCTOR or JOB NURSE' },
  school: { what: 'School', command: 'JOB TEACHER' },
  library: { what: 'Library', command: 'JOB LIBRARIAN' },
  vet: { what: 'Vet and dog park', command: 'JOB VET' },
  police: { what: 'Police station, KPD', command: 'JOB POLICE' },
  firestation: { what: 'Fire station, KFD', command: 'JOB FIREFIGHTER' },
};
const STAFF_SHOWN = 24;
const plural = (n: number, job: string) => `${n.toLocaleString()} ${n === 1 ? job.toLowerCase() : job.toLowerCase() + 's'}`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (html) node.innerHTML = html;
  return node;
}

const coarsePointer = () => matchMedia('(pointer: coarse)').matches;
const residentsLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'resident' : 'residents'}`;

export const createUI: CreateUI = (root) => {
  let sky: SkyState = skyAt(new Date());
  let current: { resident: Resident; data: CityData } | null = null;
  const searchCbs: ((q: string) => void)[] = [];
  const closedCbs: (() => void)[] = [];

  root.style.setProperty('--kb-font-display', FONTS.display);
  root.style.setProperty('--kb-font-ui', FONTS.ui);
  root.style.fontFamily = FONTS.ui;

  // ── Top bar ────────────────────────────────────────────────────────────
  const top = el('header', { class: 'kb-top' });
  const wordmark = el('h1', { class: 'kb-wordmark' });
  wordmark.textContent = 'Kinsburg';
  const stats = el('ul', { class: 'kb-stats', 'aria-label': 'City' });
  const dayChip = el('li', { class: 'kb-chip', hidden: '' });
  const popChip = el('li', { class: 'kb-chip', hidden: '' });
  const clockChip = el('li', { class: 'kb-chip kb-chip-clock' });
  const clockIcon = el('span', { class: 'kb-clock-icon' });
  const clockTime = el('time');
  clockChip.append(clockIcon, clockTime);
  const demoChip = el('li', { class: 'kb-chip kb-chip-quiet', hidden: '' });
  demoChip.textContent = 'Sample residents';
  stats.append(dayChip, popChip, clockChip, demoChip);
  const townBtn = el('button', { type: 'button', class: 'kb-btn kb-btn-secondary kb-town-btn' }, ICONS.flag);
  townBtn.append(document.createTextNode('Town hall'));
  top.append(wordmark, stats, townBtn);

  // ── Search ─────────────────────────────────────────────────────────────
  const form = el('form', { class: 'kb-search', role: 'search' });
  const label = el('label', { class: 'kb-vh', for: 'kb-search-input' });
  label.textContent = 'Find your home';
  const input = el('input', {
    id: 'kb-search-input',
    class: 'kb-search-input',
    type: 'search',
    name: 'handle',
    placeholder: '@yourname',
    autocapitalize: 'off',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
  });
  const findBtn = el('button', { type: 'submit', class: 'kb-btn kb-btn-primary kb-search-btn' });
  findBtn.textContent = 'Find';
  form.append(label, input, findBtn);

  // ── Not found ──────────────────────────────────────────────────────────
  const notFound = el('section', { class: 'kb-panel kb-notfound', hidden: '', 'aria-labelledby': 'kb-nf-title' });
  const nfLive = el('div', { class: 'kb-notfound-body', role: 'status', 'aria-live': 'polite' });
  const nfClose = el('button', { type: 'button', class: 'kb-icon-btn', 'aria-label': 'Dismiss' }, ICONS.close);
  notFound.append(nfLive, nfClose);

  // ── Resident card ──────────────────────────────────────────────────────
  const card = el('dialog', { class: 'kb-panel kb-card', 'aria-labelledby': 'kb-card-title' });
  const cardHead = el('div', { class: 'kb-card-head' });
  const cardTitle = el('h2', { id: 'kb-card-title', class: 'kb-card-title', tabindex: '-1' });
  const cardClose = el('button', { type: 'button', class: 'kb-icon-btn', 'aria-label': 'Close' }, ICONS.close);
  cardHead.append(cardTitle, cardClose);
  const cardNumber = el('p', { class: 'kb-card-number' });
  const facts = el('ul', { class: 'kb-facts' });
  const perks = el('ul', { class: 'kb-perks', 'aria-label': 'Perks' });
  const actions = el('div', { class: 'kb-card-actions' });
  const shareBtn = el('button', { type: 'button', class: 'kb-btn kb-btn-primary' });
  shareBtn.textContent = 'Share my card';
  const copyBtn = el('button', { type: 'button', class: 'kb-btn kb-btn-secondary' });
  copyBtn.textContent = 'Copy link';
  actions.append(shareBtn, copyBtn);
  // supporting the city: a gold star for this house (only when the shop is open)
  const starLink = el('a', { class: 'kb-btn kb-btn-quiet kb-card-buy', target: '_blank', rel: 'noopener', hidden: '' });
  // following is encouraged, never required
  const nudge = el('p', { class: 'kb-card-nudge', hidden: '' });
  // building cards: who works here (tap a name to fly to their house) and how to join them
  const staff = el('ul', { class: 'kb-staff', 'aria-label': 'Who works here', hidden: '' });
  const buildingNote = el('p', { class: 'kb-card-nudge', hidden: '' });
  // announces copy/share results to screen readers (button text alone may not be read)
  const cardStatus = el('p', { class: 'kb-vh', role: 'status', 'aria-live': 'polite' });
  card.append(cardHead, cardNumber, facts, staff, perks, actions, starLink, nudge, buildingNote, cardStatus);
  /** Show the parts of the card for a resident (true) or a building (false). */
  const cardMode = (resident: boolean) => {
    actions.hidden = !resident;
    staff.hidden = resident;
    buildingNote.hidden = resident;
    if (!resident) {
      perks.hidden = true;
      starLink.hidden = true;
      nudge.hidden = true;
    }
  };
  const town = createTownPanel();
  let townInfo: TownInfo | null = null;

  // ── Splash ─────────────────────────────────────────────────────────────
  const splash = el('div', { class: 'kb-splash' });
  const splashInner = el('div', { class: 'kb-splash-inner' });
  const splashMark = el('div', { class: 'kb-wordmark kb-splash-mark', 'aria-hidden': 'true' });
  splashMark.textContent = 'Kinsburg';
  const loading = el('div', { class: 'kb-loading' });
  const progress = el('div', {
    class: 'kb-progress',
    role: 'progressbar',
    'aria-label': 'Loading Kinsburg',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  });
  const progressFill = el('div', { class: 'kb-progress-fill' });
  progress.append(progressFill);
  const loadingText = el('p', { class: 'kb-splash-text' });
  loadingText.textContent = 'Loading Kinsburg';
  loading.append(progress, loadingText);
  const errorBox = el('div', { class: 'kb-error', hidden: '' });
  const errorText = el('p', { class: 'kb-splash-text', role: 'alert' });
  const retryBtn = el('button', { type: 'button', class: 'kb-btn kb-btn-primary' });
  retryBtn.textContent = 'Try again';
  errorBox.append(errorText, retryBtn);
  splashInner.append(splashMark, loading, errorBox);
  splash.append(splashInner);

  root.append(top, notFound, form, card, town.dialog, splash);
  townBtn.addEventListener('click', () => openTown());
  town.onClosed(() => {
    root.classList.remove('kb-town-open');
    townBtn.focus({ preventScroll: true });
  });
  // on phones the sheet covers the search bar; take the bar out while it's open
  const openTown = (section?: Parameters<typeof town.open>[0]) => {
    if (card.open) card.close();
    root.classList.add('kb-town-open');
    town.open(section);
  };

  // ── Behaviour ──────────────────────────────────────────────────────────
  const hideNotFound = () => {
    notFound.hidden = true;
    nfLive.textContent = '';
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    hideNotFound();
    if (coarsePointer()) input.blur(); // drop the keyboard so the map and card are visible
    for (const cb of searchCbs) cb(input.value);
  });
  nfClose.addEventListener('click', () => {
    hideNotFound();
    input.focus();
  });

  let returnFocus = false;
  const focusSearch = () => {
    // On touch screens, focusing the text field would pop the keyboard up.
    (coarsePointer() ? findBtn : input).focus({ preventScroll: true });
  };
  card.addEventListener('close', () => {
    current = null;
    root.classList.remove('kb-card-open');
    if (returnFocus) focusSearch();
    returnFocus = false;
    for (const cb of closedCbs) cb();
  });
  const closeCard = () => {
    if (!card.open) return;
    const active = document.activeElement;
    returnFocus = !!active && (card.contains(active) || active === document.body);
    card.close();
  };
  cardClose.addEventListener('click', closeCard);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (card.open) {
      e.preventDefault();
      closeCard();
    } else if (!notFound.hidden) {
      e.preventDefault();
      hideNotFound();
    }
  });

  const flash = (btn: HTMLButtonElement, text: string, rest: string) => {
    btn.textContent = text;
    cardStatus.textContent = text;
    window.setTimeout(() => {
      if (btn.textContent === text) btn.textContent = rest;
    }, 2000);
  };

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea', { readonly: '', 'aria-hidden': 'true', class: 'kb-offscreen' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  copyBtn.addEventListener('click', async () => {
    if (!current) return;
    const link = `${location.origin}/?r=${encodeURIComponent(current.resident.id)}`;
    const ok = await copyText(link);
    flash(copyBtn, ok ? 'Link copied' : "Couldn't copy", 'Copy link');
  });

  shareBtn.addEventListener('click', async () => {
    if (!current || shareBtn.getAttribute('aria-busy') === 'true') return;
    const { resident, data } = current;
    shareBtn.setAttribute('aria-busy', 'true');
    shareBtn.disabled = true;
    shareBtn.textContent = 'Making your card';
    let result: 'shared' | 'downloaded' | 'cancelled' | 'failed' = 'failed';
    try {
      const blob = await renderShareCard(resident, data, sky);
      result = await shareOrDownload(blob, resident.handle);
    } catch (err) {
      console.error('Share card failed', err);
    }
    shareBtn.removeAttribute('aria-busy');
    shareBtn.disabled = false;
    shareBtn.textContent = 'Share my card';
    if (result === 'downloaded') flash(shareBtn, 'Card saved', 'Share my card');
    else if (result === 'failed') flash(shareBtn, "Couldn't make the card", 'Share my card');
    shareBtn.focus({ preventScroll: true });
  });

  const setDemo = (demo: boolean) => {
    demoChip.hidden = !demo;
  };

  const detectDemo = (s: CityStats) => setDemo(s.demo);

  function fillBuilding(b: BuildingRef, data: CityData) {
    if (b.kind === 'townhall') return;
    const copy = BUILDING_COPY[b.kind];
    cardTitle.textContent = b.name;
    cardNumber.textContent = copy.what;
    const jobs = SERVICE_STAFF[b.kind] as readonly string[];
    const people = data.residents
      .filter((r) => jobs.includes(r.job))
      .sort((a, z) => (z.level ?? 0) - (a.level ?? 0) || a.number - z.number);
    facts.replaceChildren();
    for (const job of jobs) {
      const n = people.filter((r) => r.job === job).length;
      const li = el('li', { class: 'kb-fact' }, ICONS.people);
      li.append(document.createTextNode(n ? `${plural(n, job)} work here` : `No ${job.toLowerCase()}s yet`));
      facts.append(li);
    }
    if (b.kind === 'vet') {
      const pets = data.residents.filter((r) => r.pet).length;
      const li = el('li', { class: 'kb-fact' }, ICONS.paw);
      li.append(document.createTextNode(pets ? `${pets.toLocaleString()} ${pets === 1 ? 'pet lives' : 'pets live'} in Kinsburg` : 'No pets in town yet'));
      facts.append(li);
    }
    staff.replaceChildren();
    for (const r of people.slice(0, STAFF_SHOWN)) {
      const btn = el('button', { type: 'button' });
      btn.textContent = `@${r.handle}`;
      btn.addEventListener('click', () => searchCbs.forEach((cb) => cb(r.handle)));
      const li = el('li');
      li.append(btn);
      staff.append(li);
    }
    if (people.length > STAFF_SHOWN) staff.append(el('li', { class: 'kb-staff-more' }, `and ${(people.length - STAFF_SHOWN).toLocaleString()} more`));
    const account = townInfo?.account ?? data.account;
    buildingNote.replaceChildren();
    const ig = el('a', { href: `https://instagram.com/${account}`, target: '_blank', rel: 'noopener' });
    ig.textContent = `@${account}`;
    buildingNote.append(`Work here: comment ${copy.command} on any post by `, ig, '. You can change jobs once a week.');
    if (b.kind === 'vet') buildingNote.append(' Get a pet: comment PET DOG, PET CAT or PET BUNNY. Rare pets (fox, owl, golden retriever) come with the shop.');
    cardMode(false);
    staff.hidden = people.length === 0;
  }

  function fillCard(resident: Resident, data: CityData) {
    cardMode(true);
    cardTitle.textContent = '@' + resident.handle;
    cardNumber.textContent = `Resident #${resident.number.toLocaleString()}`;

    facts.replaceChildren();
    const fact = (icon: string, hiddenLabel: string, text: string) => {
      const li = el('li', { class: 'kb-fact' }, icon);
      if (hiddenLabel) li.append(el('span', { class: 'kb-vh' }, hiddenLabel));
      li.append(document.createTextNode(text));
      facts.append(li);
    };
    const address = addressOf(resident, data);
    if (address) fact(ICONS.pin, 'Address: ', address);
    fact(ICONS.work, 'Job: ', resident.job);
    fact(ICONS.key, '', `Moved in on Day ${resident.joinedDay.toLocaleString()}`);
    const storeys = 1 + (resident.level ?? 0);
    if (storeys > 1) fact(ICONS.roof, '', `${storeys}-storey house`);
    if (resident.pet) fact(ICONS.paw, 'Pet: ', PET_NAMES[resident.pet]);

    perks.replaceChildren();
    const has = (p: string) => resident.perks.includes(p as Resident['perks'][number]);
    const perk = (cls: string, icon: string, text: string) => {
      const li = el('li', { class: `kb-perk ${cls}` }, icon);
      li.append(document.createTextNode(text));
      perks.append(li);
    };
    if (has('monument') || has('street')) perk('kb-perk-founder', ICONS.flag, 'Founder');
    if (has('star')) perk('kb-perk-gold', ICONS.star, 'Gold star');
    if (has('goldRoof')) perk('kb-perk-gold', ICONS.roof, 'Golden roof');
    if (resident.follower) perk('kb-perk-follower', ICONS.key, 'Follower');

    const account = townInfo?.account ?? data.account;
    const star = townInfo?.perkLinks.star;
    starLink.hidden = !star || has('star');
    if (star) {
      starLink.href = buyUrl(star.url, resident.handle);
      starLink.textContent = star.price ? `Give this house a gold star, ${star.price}` : 'Give this house a gold star';
    }
    nudge.hidden = !!resident.follower;
    nudge.replaceChildren(document.createTextNode('Follow '));
    const ig = el('a', { href: `https://instagram.com/${account}`, target: '_blank', rel: 'noopener' });
    ig.textContent = `@${account}`;
    nudge.append(ig, document.createTextNode(' to watch this house grow.'));
    perks.hidden = perks.childElementCount === 0;

    copyBtn.textContent = 'Copy link';
    if (shareBtn.getAttribute('aria-busy') !== 'true') shareBtn.textContent = 'Share my card';
  }

  const ui: AppUI = {
    setTown(t, data) {
      townInfo = t;
      town.update(t, data);
      if (current) fillCard(current.resident, current.data);
    },
    openTown(section) {
      openTown(section);
    },
    setLoading(p) {
      const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
      progressFill.style.transform = `scaleX(${pct / 100})`;
      progress.setAttribute('aria-valuenow', String(pct));
    },
    ready() {
      ui.setLoading(1);
      splash.classList.add('kb-splash-done');
      const remove = () => {
        splash.hidden = true;
      };
      splash.addEventListener('transitionend', remove, { once: true });
      window.setTimeout(remove, 700); // in case transitions are off
    },
    showError(retry) {
      splash.hidden = false;
      splash.classList.remove('kb-splash-done');
      loading.hidden = true;
      errorBox.hidden = false;
      errorText.textContent = "Kinsburg didn't load. Check your connection and try again.";
      retryBtn.onclick = () => retry();
      retryBtn.focus();
    },
    setStats(s) {
      dayChip.textContent = `Day ${s.day.toLocaleString()}`;
      popChip.textContent = residentsLabel(s.residents);
      dayChip.hidden = false;
      popChip.hidden = false;
      detectDemo(s);
    },
    setSky(next, now) {
      sky = next;
      const night = next.phase === 'night' || next.phase === 'dusk';
      clockIcon.innerHTML = night ? ICONS.moon : ICONS.sun;
      clockChip.classList.toggle('kb-chip-night', night);
      clockTime.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      clockTime.dateTime = now.toISOString();
    },
    openResident(resident, data) {
      setDemo(!!data.demo);
      hideNotFound();
      current = { resident, data };
      fillCard(resident, data);
      if (!card.open) card.show();
      root.classList.add('kb-card-open');
      cardTitle.focus({ preventScroll: true });
    },
    openBuilding(building, data) {
      if (building.kind === 'townhall') return ui.openTown();
      hideNotFound();
      current = null;
      fillBuilding(building, data);
      if (!card.open) card.show();
      root.classList.add('kb-card-open');
      cardTitle.focus({ preventScroll: true });
    },
    closeCard,
    showNotFound(handle, account) {
      closeCard();
      const clean = handle.replace(/^@+/, '');
      nfLive.replaceChildren();
      const title = el('p', { id: 'kb-nf-title', class: 'kb-notfound-title' });
      title.textContent = `@${clean} hasn't moved in yet.`;
      const body = el('p', { class: 'kb-notfound-text' });
      const link = el('a', {
        href: `https://instagram.com/${encodeURIComponent(account)}`,
        target: '_blank',
        rel: 'noopener',
      });
      link.textContent = `@${account}`;
      body.append('Comment MOVE IN on ', link, "'s latest post and we'll build your home.");
      const how = el('button', { type: 'button', class: 'kb-btn kb-btn-secondary kb-nf-how' });
      how.textContent = 'How to move in';
      how.addEventListener('click', () => {
        notFound.hidden = true;
        ui.openTown('move-in');
      });
      notFound.hidden = false;
      nfLive.append(title, body, how);
    },
    onSearch(cb) {
      searchCbs.push(cb);
    },
    onCardClosed(cb) {
      closedCbs.push(cb);
    },
  };
  return ui;
};
