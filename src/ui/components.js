'use strict';

const { createIcon } = require('./icons.js');
const copy = require('./copy.js');

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.cls) node.className = props.cls;
  if (props.text != null) node.textContent = String(props.text);
  if (props.title) node.title = props.title;
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) {
      if (value == null || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      if (key.startsWith('--')) node.style.setProperty(key, value);
      else node.style[key] = value;
    }
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) {
      if (value != null) node.dataset[key] = String(value);
    }
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

function icon(name, size = 16, className = 'mf-icon') {
  return createIcon(name, size, className);
}

function button({
  label = '',
  iconName = null,
  variant = 'ghost',
  title = '',
  action = null,
  data = null,
  iconOnly = false,
  onClick = null,
  className = '',
} = {}) {
  const classes = ['mf-btn', `mf-btn-${variant}`];
  if (iconOnly) classes.push('mf-icon-btn');
  if (className) classes.push(className);
  const node = el('button', {
    cls: classes.join(' '),
    title: title || label,
    attrs: { type: 'button', 'aria-label': title || label },
    dataset: action ? { action, ...(data || {}) } : data,
  });
  if (iconName) node.appendChild(icon(iconName, iconOnly ? 16 : 15));
  if (label) node.appendChild(el('span', { cls: 'mf-btn-label', text: label }));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function ring(value, { size = 132, stroke = 9, label = '今日进度' } = {}) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const wrap = el('div', {
    cls: 'mf-ring',
    style: { width: `${size}px`, height: `${size}px` },
    attrs: { role: 'img', 'aria-label': `${label} ${Math.round(pct * 100)}%` },
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'mf-ring-svg');
  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(radius));
  track.setAttribute('class', 'mf-ring-track');
  track.setAttribute('stroke-width', String(stroke));
  const valueCircle = document.createElementNS(SVG_NS, 'circle');
  valueCircle.setAttribute('cx', String(size / 2));
  valueCircle.setAttribute('cy', String(size / 2));
  valueCircle.setAttribute('r', String(radius));
  valueCircle.setAttribute('class', 'mf-ring-value');
  valueCircle.setAttribute('stroke-width', String(stroke));
  valueCircle.setAttribute('stroke-dasharray', `${circumference}`);
  valueCircle.setAttribute('stroke-dashoffset', `${circumference * (1 - pct)}`);
  valueCircle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
  svg.appendChild(track);
  svg.appendChild(valueCircle);
  wrap.appendChild(svg);
  wrap.appendChild(el('div', { cls: 'mf-ring-center' }, [
    el('span', { cls: 'mf-ring-number', text: `${Math.round(pct * 100)}%` }),
    el('span', { cls: 'mf-ring-label', text: label }),
  ]));
  return wrap;
}

function barChart(items, { showValues = true, label = '' } = {}) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, ...list.map(item => Number(item.count) || 0));
  const chart = el('div', {
    cls: 'mf-bars',
    attrs: { role: 'img', 'aria-label': label || `${list.length} 天学习负荷` },
  });
  list.forEach((item, index) => {
    const count = Number(item.count) || 0;
    const height = count ? Math.max(8, Math.round((count / max) * 100)) : 2;
    const column = el('div', { cls: `mf-bar-col${item.isToday ? ' is-today' : ''}` });
    if (showValues) {
      column.appendChild(el('span', { cls: 'mf-bar-value', text: String(count) }));
    }
    const track = el('div', { cls: 'mf-bar-track' });
    const bar = el('div', {
      cls: 'mf-bar',
      style: { height: `${height}%` },
      title: `${item.label || ''}${count ? `：${count}` : '：无'}`,
    });
    track.appendChild(bar);
    column.appendChild(track);
    const showLabel = item.isToday || list.length <= 10 || index % 2 === 0;
    column.appendChild(el('span', {
      cls: 'mf-bar-label',
      text: showLabel ? (item.isToday ? '今天' : (item.shortLabel || item.label || '')) : '',
    }));
    chart.appendChild(column);
  });
  return chart;
}

function progressBar(value, tone = 'accent') {
  const pct = Math.max(0, Math.min(1, Number(value) || 0));
  const track = el('div', { cls: 'mf-progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)) } });
  track.appendChild(el('div', { cls: `mf-progress-fill is-${tone}`, style: { width: `${pct * 100}%` } }));
  return track;
}

function typeIcon(type) {
  if (type === 'source') return 'book';
  if (type === 'extract') return 'extract';
  if (type === 'card') return 'card';
  if (type === 'category') return 'tree';
  return 'file';
}

function typeClass(type) {
  return ['source', 'extract', 'card', 'category'].includes(type) ? type : 'file';
}

function priorityTone(priority) {
  if (priority == null) return 'none';
  if (priority <= 25) return 'high';
  if (priority <= 60) return 'mid';
  return 'low';
}

function emptyState({ iconName = 'spark', title, text = '', steps = null, actions = [] } = {}) {
  const wrap = el('div', { cls: 'mf-empty' });
  wrap.appendChild(el('div', { cls: 'mf-empty-icon' }, [icon(iconName, 22)]));
  wrap.appendChild(el('h3', { cls: 'mf-empty-title', text: title || '' }));
  if (text) wrap.appendChild(el('p', { cls: 'mf-empty-text', text }));
  if (steps && steps.length) {
    const list = el('ol', { cls: 'mf-steps' });
    for (const step of steps) list.appendChild(el('li', { text: step }));
    wrap.appendChild(list);
  }
  if (actions.length) {
    const row = el('div', { cls: 'mf-empty-actions' });
    for (const action of actions) row.appendChild(button(action));
    wrap.appendChild(row);
  }
  return wrap;
}

function skeletonBlock(width = '100%', height = '14px', extra = '') {
  return el('div', { cls: `mf-skel ${extra}`.trim(), style: { width, height } });
}

function dashboardSkeleton() {
  const wrap = el('div', { cls: 'mf-skeleton' });
  const hero = el('div', { cls: 'mf-skel-hero' }, [
    skeletonBlock('38%', '34px'),
    skeletonBlock('22%', '18px'),
    skeletonBlock('100%', '88px', 'mf-skel-soft'),
  ]);
  const grid = el('div', { cls: 'mf-skel-grid' }, [
    skeletonBlock('100%', '260px', 'mf-skel-panel'),
    skeletonBlock('100%', '260px', 'mf-skel-panel'),
  ]);
  wrap.appendChild(hero);
  wrap.appendChild(grid);
  return wrap;
}

function countPill(value) {
  return el('span', { cls: 'mf-count', text: String(value) });
}

function menuItem({ iconName, label, action, data }) {
  const node = el('button', {
    cls: 'mf-menu-item',
    attrs: { type: 'button' },
    dataset: { action, ...(data || {}) },
  });
  if (iconName) node.appendChild(icon(iconName, 15));
  node.appendChild(el('span', { text: label }));
  return node;
}

module.exports = {
  SVG_NS,
  el,
  appendChildren,
  icon,
  button,
  ring,
  barChart,
  progressBar,
  typeIcon,
  typeClass,
  priorityTone,
  emptyState,
  dashboardSkeleton,
  skeletonBlock,
  countPill,
  menuItem,
  copy,
};
