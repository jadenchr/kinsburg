// Inline SVG icons for the UI. All use currentColor and are decorative
// (aria-hidden); the text next to them carries the meaning.

const svg = (body: string, size = 16) =>
  `<svg class="kb-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  sun: svg(
    '<circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/>' +
      '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  ),
  moon: svg('<path d="M20 14.6A8.3 8.3 0 0 1 9.4 4a8.3 8.3 0 1 0 10.6 10.6Z" fill="currentColor" stroke="none"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>', 20),
  pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>'),
  work: svg('<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 12.5h17"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>'),
  star: svg('<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8Z" fill="currentColor"/>', 14),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', 14),
  paw: svg('<circle cx="12" cy="15.5" r="3.6" fill="currentColor" stroke="none"/><circle cx="6.5" cy="10.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="9.8" cy="6.8" r="1.8" fill="currentColor" stroke="none"/><circle cx="14.2" cy="6.8" r="1.8" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.8" fill="currentColor" stroke="none"/>'),
  people: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.2a3.2 3.2 0 0 1 0 6M17.2 14.2c1.8.6 3 2.2 3.3 4.8"/>'),
  coin: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M14.6 9.6c-.5-.8-1.4-1.1-2.6-1.1-1.5 0-2.4.7-2.4 1.8 0 2.5 5.2 1.2 5.2 3.7 0 1.100-1 1.800-2.700 1.800-1.200 0-2.200-.4-2.800-1.300"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.4C19.500 15.400 12 20 12 20Z" fill="currentColor" stroke="none"/>', 14),
  roof: svg('<path d="M3 12 12 4l9 8M6 10v9h12v-9" />', 14),
} as const;
