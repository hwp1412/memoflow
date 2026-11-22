'use strict';

const { createDashboard } = require('../src/ui/dashboard.js');
const { buildDemoModel, buildEmptyModel } = require('../src/data/demo.js');

const params = new URLSearchParams(window.location.search);
const app = document.getElementById('app');

const state = {
  query: '',
  filter: 'all',
  sort: 'urgency',
  demo: params.get('demo') !== '0',
  empty: params.get('empty') === '1',
  theme: params.get('theme') === 'dark' ? 'dark' : 'light',
  narrow: params.get('narrow') === '1',
  expanded: new Set(),
  collapsed: new Set(),
};

document.body.classList.toggle('theme-dark', state.theme === 'dark');
document.body.classList.toggle('mf-preview-narrow', state.narrow);
document.body.classList.toggle('preview-bare', params.get('bare') === '1');
const fixedWidth = Number(params.get('w'));
if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
  document.documentElement.style.setProperty('--mf-preview-width', `${fixedWidth}px`);
  document.body.classList.add('mf-preview-fixed-width');
}

const ui = createDashboard(app, {
  onAction: handleAction,
  isMobile: window.innerWidth < 720,
});

function buildModel() {
  const model = state.empty
    ? buildEmptyModel(new Date(), { isMobile: window.innerWidth < 720 })
    : buildDemoModel(new Date(), { isMobile: window.innerWidth < 720 });
  if (!state.empty) model.demo = state.demo;
  if (!state.empty) model.isMobile = window.innerWidth < 720;
  return model;
}

let model = buildModel();
ui.update(model, state);

if (params.get('debug') === '1') {
  const view = document.querySelector('.mf-view');
  const hero = document.querySelector('.mf-hero-main');
  const queue = document.querySelector('.mf-queue-panel');
  const body = document.querySelector('.mf-body');
  const metrics = {
    innerWidth: window.innerWidth,
    docClientWidth: document.documentElement.clientWidth,
    viewClientWidth: view ? view.clientWidth : null,
    viewScrollWidth: view ? view.scrollWidth : null,
    bodyClientWidth: body ? body.clientWidth : null,
    bodyScrollWidth: body ? body.scrollWidth : null,
    heroWidth: hero ? Math.round(hero.getBoundingClientRect().width) : null,
    queueWidth: queue ? Math.round(queue.getBoundingClientRect().width) : null,
  };
  const debug = document.createElement('pre');
  debug.id = 'mf-debug';
  debug.textContent = JSON.stringify(metrics);
  debug.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#fff;color:#000;font-size:11px;max-width:100%;white-space:pre-wrap;';
  document.body.appendChild(debug);
}

function refresh() {
  model = buildModel();
  ui.update(model, state);
}

function showToast(message) {
  let toast = document.querySelector('.preview-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'preview-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 1800);
}

function handleAction(action, data) {
  switch (action) {
    case 'search':
      state.query = data.query || '';
      ui.updateLists(model, state);
      return;
    case 'filter':
      state.filter = data.filter || 'all';
      ui.updateLists(model, state);
      return;
    case 'sort':
      state.sort = data.sort || 'urgency';
      ui.updateLists(model, state);
      return;
    case 'tree-toggle': {
      const depth = Number(data.depth) || 0;
      const set = depth === 0 ? state.collapsed : state.expanded;
      if (set.has(data.path)) set.delete(data.path);
      else set.add(data.path);
      ui.updateLists(model, state);
      return;
    }
    case 'clear-filters':
      state.query = '';
      state.filter = 'all';
      ui.setSearchValue('');
      ui.updateLists(model, state);
      return;
    case 'demo-toggle':
      state.empty = false;
      state.demo = !state.demo;
      refresh();
      updateControls();
      return;
    case 'retry':
    case 'refresh':
      refresh();
      return;
    default:
      showToast(`预览模式：${action}${data.path ? ` · ${data.path.split('/').pop()}` : ''}`);
  }
}

function updateControls() {
  const themeButton = document.querySelector('[data-control="theme"]');
  if (themeButton) themeButton.textContent = state.theme === 'dark' ? '亮色' : '暗色';
  const emptyButton = document.querySelector('[data-control="empty"]');
  if (emptyButton) emptyButton.classList.toggle('is-active', state.empty);
  const demoButton = document.querySelector('[data-control="demo"]');
  if (demoButton) demoButton.classList.toggle('is-active', state.demo && !state.empty);
  const widthButton = document.querySelector('[data-control="width"]');
  if (widthButton) widthButton.classList.toggle('is-active', state.narrow);
}

for (const control of document.querySelectorAll('[data-control]')) {
  control.addEventListener('click', () => {
    const name = control.dataset.control;
    if (name === 'theme') {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.body.classList.toggle('theme-dark', state.theme === 'dark');
    } else if (name === 'empty') {
      state.empty = !state.empty;
      refresh();
    } else if (name === 'demo') {
      state.demo = !state.demo;
      state.empty = false;
      refresh();
    } else if (name === 'width') {
      state.narrow = !state.narrow;
      document.body.classList.toggle('mf-preview-narrow', state.narrow);
    }
    updateControls();
  });
}

updateControls();
