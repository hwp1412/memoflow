'use strict';

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  search: [
    { tag: 'path', d: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z' },
    { tag: 'path', d: 'm21 21-4.35-4.35' },
  ],
  refresh: [
    { tag: 'path', d: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4' },
    { tag: 'path', d: 'M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4' },
  ],
  more: [
    { tag: 'circle', cx: 5, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' },
    { tag: 'circle', cx: 12, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' },
    { tag: 'circle', cx: 19, cy: 12, r: 1.4, fill: 'currentColor', stroke: 'none' },
  ],
  book: [
    { tag: 'path', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 0 4 18.5V5.5Z' },
    { tag: 'path', d: 'M4 18.5A2.5 2.5 0 0 1 6.5 16H20' },
    { tag: 'path', d: 'M8 7h7M8 10.5h5' },
  ],
  extract: [
    { tag: 'path', d: 'M6 3h8l4 4v14H6z' },
    { tag: 'path', d: 'M14 3v4h4' },
    { tag: 'path', d: 'M9 12h6M9 16h6' },
  ],
  card: [
    { tag: 'path', d: 'M4 7h16v10H4z' },
    { tag: 'path', d: 'M8 11h8M8 14h5' },
  ],
  tree: [
    { tag: 'path', d: 'M6 4v16' },
    { tag: 'path', d: 'M6 8h5M11 8v4M11 12h7M6 14h5M11 14v4M11 18h7' },
  ],
  clock: [
    { tag: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
    { tag: 'path', d: 'M12 7v5l3 2' },
  ],
  flame: [
    { tag: 'path', d: 'M12 22c4 0 7-2.7 7-6.5 0-2.4-1.5-4.4-3.2-6.1C14.5 8.1 13 6 12 3c-.5 3-2 5.2-4 7.2C6.4 11.9 5 13.7 5 15.5 5 19.3 8 22 12 22Z' },
    { tag: 'path', d: 'M12 18c1.7 0 3-1.2 3-2.8 0-1.5-1.7-2.8-3-4.2-1.3 1.4-3 2.7-3 4.2 0 1.6 1.3 2.8 3 2.8Z' },
  ],
  target: [
    { tag: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z' },
    { tag: 'path', d: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
    { tag: 'circle', cx: 12, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' },
  ],
  trend: [
    { tag: 'path', d: 'm4 17 6-6 4 4 6-8' },
    { tag: 'path', d: 'M20 7h-4M20 7v4' },
  ],
  chevronRight: [{ tag: 'path', d: 'm9 6 6 6-6 6' }],
  chevronDown: [{ tag: 'path', d: 'm6 9 6 6 6-6' }],
  arrowRight: [{ tag: 'path', d: 'M5 12h14M13 6l6 6-6 6' }],
  plus: [{ tag: 'path', d: 'M12 5v14M5 12h14' }],
  check: [{ tag: 'path', d: 'm5 12 4 4L19 6' }],
  spark: [{ tag: 'path', d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z' }],
  alert: [
    { tag: 'path', d: 'M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z' },
    { tag: 'path', d: 'M12 9v4' },
    { tag: 'circle', cx: 12, cy: 16.5, r: 1, fill: 'currentColor', stroke: 'none' },
  ],
  inbox: [
    { tag: 'path', d: 'M4 13h4l2 3h4l2-3h4' },
    { tag: 'path', d: 'M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7' },
    { tag: 'path', d: 'M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5' },
  ],
  file: [
    { tag: 'path', d: 'M6 3h8l4 4v14H6z' },
    { tag: 'path', d: 'M14 3v4h4' },
  ],
  calendar: [
    { tag: 'path', d: 'M5 5h14v16H5z' },
    { tag: 'path', d: 'M8 3v4M16 3v4M5 10h14' },
  ],
  layers: [
    { tag: 'path', d: 'M12 3 3 8l9 5 9-5-9-5Z' },
    { tag: 'path', d: 'm3 13 9 5 9-5' },
    { tag: 'path', d: 'm3 18 9 5 9-5' },
  ],
  dot: [{ tag: 'circle', cx: 12, cy: 12, r: 2, fill: 'currentColor', stroke: 'none' }],
  play: [{ tag: 'path', d: 'M8 5v14l11-7L8 5Z' }],
};

function createIcon(name, size = 16, className = 'mf-icon') {
  const spec = ICONS[name] || ICONS.dot;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const shape of spec) {
    const node = document.createElementNS(NS, shape.tag);
    for (const [key, value] of Object.entries(shape)) {
      if (key === 'tag') continue;
      node.setAttribute(key, String(value));
    }
    svg.appendChild(node);
  }
  return svg;
}

module.exports = { ICONS, createIcon };
