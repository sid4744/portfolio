// Small line icons for categories (inline SVG, they take the text colour).
const PATHS = {
  vehicles: '<path d="M2.5 15.5v-3.2l2.3-4.3h9.4l3.6 4 3.2.9v2.6h-2.4"/><path d="M8 15.5h6.3"/><circle cx="5.9" cy="16" r="2"/><circle cx="16.4" cy="16" r="2"/>',
  mechanical: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  product: '<path d="M3 18a9 9 0 0 1 18 0z"/><path d="M12 18v-3M6.1 12.6l1.7 1.5M17.9 12.6l-1.7 1.5M8.6 9.7l1 1.4M15.4 9.7l-1 1.4"/>',
  tools: '<path d="M3.5 20.5l7-7"/><path d="M10 14l3.5 3.5 6.5-6.5L16.500 7.500z"/><path d="M16.5 4.5l3 3"/>',
  qtents: '<path d="M3 20L12 4l9 16z"/><path d="M12 4v16M9 20l3-6 3 6"/>',
  software: '<path d="M11 3l1.9 5.6L18.500 10.500 12.900 12.400 11 18l-1.900-5.600L3.500 10.500 9.100 8.600z"/><path d="M18.500 15.500l.7 1.800 1.800.7-1.800.7-.7 1.800-.7-1.800-1.800-.7 1.800-.7z"/>',
};

export function catKey(name = '') {
  const n = name.toLowerCase();
  if (n.startsWith('vehicle')) return 'vehicles';
  if (n.startsWith('mech')) return 'mechanical';
  if (n.startsWith('product')) return 'product';
  if (n.startsWith('tool')) return 'tools';
  if (n.startsWith('qtent') || n.startsWith('tensile')) return 'qtents';
  if (n.startsWith('software') || n.includes('claude') || n.includes('vibecode')) return 'software';
  return null;
}

export function catIcon(name) {
  const k = catKey(name);
  const span = document.createElement('span');
  span.className = 'ico';
  if (k) span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[k]}</svg>`;
  return k ? span : null;
}
