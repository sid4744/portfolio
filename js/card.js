// Generated "title card" for projects that have no 3D model and no cover image
// (software, written work). Black, grainy, big type: same language as the UI.
export function titleCard(project, index, size = 640) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#050505'; g.fillRect(0, 0, size, size);

  // grain, seeded by id so a card looks the same every time
  let seed = 0; for (const ch of project.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = '#f4f4f1';
  for (let i = 0; i < size * size * 0.018; i++) g.fillRect((rnd() * size) | 0, (rnd() * size) | 0, 2, 2);

  g.strokeStyle = '#f4f4f1'; g.lineWidth = 4; g.strokeRect(22, 22, size - 44, size - 44);
  g.fillStyle = '#f4f4f1'; g.textBaseline = 'top';
  g.font = `700 ${size * 0.22}px "Arial Narrow", Impact, Arial, sans-serif`;
  g.fillText(String(index + 1).padStart(2, '0'), 44, 36);

  // title, wrapped, bottom-aligned
  const fs = size * 0.105;
  g.font = `700 ${fs}px "Arial Narrow", Impact, Arial, sans-serif`;
  const words = project.title.toUpperCase().split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (g.measureText(t).width > size - 90 && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 4);
  const y0 = size - 52 - shown.length * fs * 1.02 - size * 0.05;
  shown.forEach((l, i) => g.fillText(l, 44, y0 + i * fs * 1.02));
  g.font = `700 ${size * 0.04}px "Cascadia Mono", Consolas, monospace`;
  g.fillText((project.category || '').toUpperCase(), 44, size - 44 - size * 0.04);
  return c;
}
