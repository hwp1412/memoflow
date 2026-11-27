'use strict';

const {
  el,
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
  countPill,
  copy,
} = require('./components.js');
const text = require('../data/text.js');

const SVG_NS = 'http://www.w3.org/2000/svg';
const TYPE_LABEL = { source: '阅读', extract: '摘录', card: '卡片', category: '分类' };

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatAF(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function brandMark() {
  const wrap = el('span', { cls: 'mf-mark' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  const box = document.createElementNS(SVG_NS, 'rect');
  box.setAttribute('x', '1');
  box.setAttribute('y', '1');
  box.setAttribute('width', '26');
  box.setAttribute('height', '26');
  box.setAttribute('rx', '8');
  box.setAttribute('fill', 'currentColor');
  box.setAttribute('opacity', '0.12');
  svg.appendChild(box);
  for (const [d, width] of [['M8 10h12', 1.7], ['M8 14h9', 1.7], ['M8 18h6', 1.7]]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', String(width));
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '20');
  dot.setAttribute('cy', '18');
  dot.setAttribute('r', '2.2');
  dot.setAttribute('fill', 'currentColor');
  svg.appendChild(dot);
  wrap.appendChild(svg);
  return wrap;
}

function typeLabel(type) {
  return TYPE_LABEL[type] || '条目';
}

function typeBadge(type) {
  return el('span', { cls: `mf-type-badge is-${typeClass(type)}` }, [
    icon(typeIcon(type), 13),
    el('span', { text: typeLabel(type) }),
  ]);
}

function createDashboard(container, { onAction = () => {}, isMobile = false } = {}) {
  const root = el('div', { cls: `mf-view${isMobile ? ' mf-mobile' : ''}` });
  container.appendChild(root);

  let currentModel = null;
  let currentState = null;
  let menuOpen = false;

  const dateEl = el('span', { cls: 'mf-date' });
  const demoPill = el('span', { cls: 'mf-demo-pill', text: copy.demoPill });
  demoPill.hidden = true;

  const searchInput = el('input', {
    cls: 'mf-search-input',
    attrs: {
      type: 'search',
      placeholder: copy.searchPlaceholder,
      'aria-label': copy.searchPlaceholder,
      autocomplete: 'off',
      spellcheck: 'false',
      'data-role': 'search',
    },
  });
  const search = el('label', { cls: 'mf-search' }, [
    icon('search', 15),
    searchInput,
    el('kbd', { cls: 'mf-kbd', text: copy.searchHint }),
  ]);
  const demoLabel = el('span', { text: copy.menuDemoOn });
  const menu = el('div', { cls: 'mf-menu', attrs: { role: 'menu' } }, [
    menuItem('refresh', copy.menuRefresh, 'refresh'),
    menuItem('book', copy.menuGuide, 'guide'),
    menuItem('layers', copy.menuQueue, 'queue'),
    menuItem('tree', copy.menuTree, 'tree'),
    menuItemWithLabel('spark', copy.menuDemoOn, 'demo-toggle', demoLabel),
  ]);
  menu.hidden = true;
  const moreButton = button({ iconName: 'more', iconOnly: true, title: '更多', action: 'menu' });
  moreButton.setAttribute('aria-haspopup', 'menu');
  const menuWrap = el('div', { cls: 'mf-menu-wrap' }, [moreButton, menu]);
  const tools = el('div', { cls: 'mf-header-tools' }, [
    search,
    button({ iconName: 'refresh', iconOnly: true, title: '刷新数据', action: 'refresh' }),
    menuWrap,
  ]);
  const brand = el('div', { cls: 'mf-brand' }, [
    brandMark(),
    el('div', { cls: 'mf-brand-text' }, [
      el('div', { cls: 'mf-wordmark', text: copy.brand }),
      el('div', { cls: 'mf-subtitle', text: copy.subtitle }),
    ]),
  ]);
  const meta = el('div', { cls: 'mf-header-meta' }, [dateEl, demoPill]);
  const header = el('header', { cls: 'mf-header' }, [brand, meta, tools]);

  const bannerExit = button({ label: copy.exitDemo, variant: 'subtle', action: 'demo-toggle' });
  const banner = el('div', { cls: 'mf-demo-banner', attrs: { hidden: true } }, [
    icon('spark', 16),
    el('span', { cls: 'mf-demo-banner-text', text: copy.demoBanner }),
    bannerExit,
  ]);

  const body = el('div', { cls: 'mf-body' });
  const footer = el('footer', { cls: 'mf-footer', text: copy.footer });
  root.append(header, banner, body, footer);

  function setLoading() {
    body.empty?.();
    body.textContent = '';
    body.appendChild(dashboardSkeleton());
  }

  function setError(message) {
    body.textContent = '';
    const card = el('div', { cls: 'mf-card mf-error' }, [
      el('div', { cls: 'mf-empty-icon' }, [icon('alert', 22)]),
      el('h3', { cls: 'mf-empty-title', text: copy.errorTitle }),
      el('p', { cls: 'mf-empty-text', text: message || '请重试。' }),
      button({ label: copy.errorRetry, variant: 'primary', action: 'retry' }),
    ]);
    body.appendChild(card);
  }

  function updateHeader(model) {
    dateEl.textContent = model.dateLabel || '';
    demoPill.hidden = !model.demo;
    banner.hidden = !model.demo;
    demoLabel.textContent = model.demo ? copy.menuDemoOff : copy.menuDemoOn;
    if (document.activeElement !== searchInput) {
      searchInput.value = currentState?.query || '';
    }
    root.classList.toggle('mf-mobile', Boolean(model.isMobile || isMobile));
  }

  function update(model, state) {
    currentModel = model;
    currentState = state;
    updateHeader(model);
    renderBody(model, state);
    closeMenu();
  }

  function updateLists(model, state) {
    currentModel = model;
    currentState = state;
    renderBody(model, state);
  }

  function renderBody(model, state) {
    body.textContent = '';
    body.appendChild(renderHero(model, state));
    body.appendChild(renderMain(model, state));
  }

  function renderHero(model, state) {
    const counts = model.counts || {};
    const due = Number(counts.due) || 0;
    const newItems = Number(counts.newItems) || 0;
    const title = due > 0
      ? `今天还有 ${due} 项`
      : (newItems > 0 ? '今天没有到期项' : copy.todayDone);
    const subParts = [];
    if (due > 0) subParts.push(copy.estimated(text.formatMinutes(model.estimatedMinutes)));
    if (counts.overdue > 0) subParts.push(`逾期 ${counts.overdue} 项`);
    else if (counts.todayDue > 0) subParts.push(`今日到期 ${counts.todayDue} 项`);
    if (newItems > 0) subParts.push(`${newItems} 条新素材`);
    if (!subParts.length) subParts.push('可以安心读一点新东西');

    const copyCol = el('div', { cls: 'mf-hero-copy' }, [
      el('div', { cls: 'mf-eyebrow' }, [icon('spark', 13), el('span', { text: copy.todayStudy })]),
      el('h1', { cls: 'mf-hero-title' }, due > 0
        ? [
          el('span', { text: '今天还有 ' }),
          el('span', { cls: 'mf-hero-number', text: String(due) }),
          el('span', { text: ' 项' }),
        ]
        : [el('span', { text: title })]),
      el('p', { cls: 'mf-hero-sub', text: subParts.join(' · ') }),
      renderStats(model),
      el('div', { cls: 'mf-actions' }, [
        button({ label: copy.start, iconName: 'play', variant: 'primary', action: 'start', className: 'mf-btn-lg' }),
        button({ label: copy.openQueue, iconName: 'layers', variant: 'secondary', action: 'queue' }),
        button({ label: copy.cardReview, iconName: 'card', variant: 'secondary', action: 'card-review', title: '只复习问答 / Cloze 卡片' }),
        button({ label: copy.overload, iconName: 'calendar', variant: 'ghost', action: 'overload', title: '摊平逾期主题' }),
      ]),
    ]);
    const ringWrap = el('div', { cls: 'mf-hero-ring' }, [ring(model.progress, { size: 136, stroke: 9 })]);

    const hero = el('section', { cls: 'mf-card mf-hero-main' }, [copyCol, ringWrap]);
    const next = renderNext(model, state);
    return el('div', { cls: 'mf-hero-grid' }, [hero, next]);
  }

  function renderStats(model) {
    const counts = model.counts || {};
    const cardsDue = Number(counts.cardsDue) || 0;
    const stats = [
      { label: '逾期', value: counts.overdue || 0, tone: counts.overdue ? 'danger' : '', title: `${counts.overdue || 0} 项逾期` },
      { label: '今日到期', value: counts.todayDue || 0, tone: counts.todayDue ? 'amber' : '', title: `${counts.todayDue || 0} 项今天到期` },
      { label: '新素材', value: counts.newItems || 0, tone: '', title: `${counts.newItems || 0} 条新素材` },
      model.srReady
        ? { label: '卡片待复习', value: cardsDue, tone: cardsDue ? 'amber' : '', title: `共 ${counts.cards || 0} 张卡片` }
        : { label: '卡片（需 SR）', value: '—', tone: '', title: '安装并启用 Spaced Repetition 后可复习卡片' },
    ];
    const row = el('div', { cls: 'mf-stat-row' });
    for (const stat of stats) {
      row.appendChild(el('div', {
        cls: `mf-stat ${stat.tone ? `is-${stat.tone}` : ''}`.trim(),
        title: stat.title,
      }, [
        el('span', { cls: 'mf-stat-value', text: String(stat.value) }),
        el('span', { cls: 'mf-stat-label', text: stat.label }),
      ]));
    }
    return row;
  }

  function renderNext(model, state) {
    const item = model.hero && model.hero.primary;
    if (!item) {
      return el('aside', { cls: 'mf-card mf-next-card is-empty' }, [
        el('div', { cls: 'mf-eyebrow', text: copy.nextUp }),
        el('h2', { cls: 'mf-next-title', text: copy.todayDone }),
        el('p', { cls: 'mf-next-excerpt', text: '去读一点新东西，或者先看看示例布局。' }),
        el('div', { cls: 'mf-next-actions' }, [
          model.demo
            ? button({ label: copy.openQueue, iconName: 'layers', variant: 'secondary', action: 'queue' })
            : button({ label: copy.enterDemo, iconName: 'spark', variant: 'secondary', action: 'demo-toggle' }),
        ]),
      ]);
    }
    const metaRow = el('div', { cls: 'mf-next-meta' }, [
      item.priority != null ? el('span', { cls: `mf-pill is-${priorityTone(item.priority)}`, text: copy.priorityShort(item.priority) }) : null,
      item.interval ? el('span', { cls: 'mf-next-meta-item', text: copy.intervalShort(item.interval) }) : null,
      item.aFactor ? el('span', { cls: 'mf-next-meta-item', text: copy.afShort(formatAF(item.aFactor)) }) : null,
      el('span', { cls: `mf-due is-${item.dueTone}`, text: item.dueLabel, title: item.dueTitle }),
    ]);
    const actions = [
      button({ label: copy.open, iconName: 'arrowRight', variant: 'secondary', action: 'open', data: { path: item.path } }),
    ];
    if (item.type === 'source' && item.hasPdf) {
      actions.push(button({ label: copy.openPdf, iconName: 'file', variant: 'subtle', action: 'open-pdf', data: { path: item.path } }));
    }
    return el('aside', { cls: 'mf-card mf-next-card' }, [
      el('div', { cls: 'mf-next-head' }, [
        el('div', { cls: 'mf-eyebrow', text: copy.nextUpEyebrow }),
        typeBadge(item.type),
      ]),
      el('h2', { cls: 'mf-next-title', text: item.basename }),
      item.sourceTitle ? el('div', { cls: 'mf-next-source', text: `来源 · ${item.sourceTitle}` }) : null,
      el('p', { cls: 'mf-next-excerpt', text: item.excerpt || '打开后继续上次的阅读位置。' }),
      metaRow,
      el('div', { cls: 'mf-next-actions' }, actions),
    ]);
  }

  function renderMain(model, state) {
    const left = el('div', { cls: 'mf-main-col' }, [renderQueue(model, state)]);
    const recent = renderRecent(model, state);
    if (recent) left.appendChild(recent);
    left.appendChild(renderQuickActions());
    const rail = el('aside', { cls: 'mf-rail' }, [
      renderRhythm(model),
      renderTree(model, state),
      renderSources(model),
    ]);
    return el('div', { cls: 'mf-main' }, [left, rail]);
  }

  function panelHeading(title, count) {
    const heading = el('div', { cls: 'mf-panel-heading' }, [
      el('span', { cls: 'mf-title-dot' }),
      el('span', { cls: 'mf-panel-title-text', text: title }),
    ]);
    if (count != null) heading.appendChild(countPill(count));
    return heading;
  }

  function simplePanel({ title, count, cls = '', section = null, children = [] }) {
    const panel = el('section', {
      cls: `mf-card mf-panel ${cls}`.trim(),
      dataset: section ? { section } : null,
    });
    panel.appendChild(el('div', { cls: 'mf-panel-head' }, [panelHeading(title, count)]));
    for (const child of children) if (child) panel.appendChild(child);
    return panel;
  }

  function filterQueue(queue, state) {
    const query = String(state.query || '').trim().toLowerCase();
    let list = (queue || []).slice();
    if (state.filter === 'source' || state.filter === 'extract' || state.filter === 'card') {
      list = list.filter(item => item.type === state.filter);
    } else if (state.filter === 'overdue') {
      list = list.filter(item => item.isOverdue);
    }
    if (query) {
      list = list.filter(item => {
        const haystack = [item.basename, item.sourceTitle, typeLabel(item.type)].join(' ').toLowerCase();
        return haystack.includes(query);
      });
    }
    if (state.sort === 'priority') {
      list.sort((a, b) => {
        const ap = a.priority == null ? 999 : a.priority;
        const bp = b.priority == null ? 999 : b.priority;
        return ap - bp || String(a.basename).localeCompare(String(b.basename), 'zh-CN');
      });
    } else if (state.sort === 'due') {
      list.sort((a, b) => {
        const at = a.dueTime == null ? Infinity : a.dueTime;
        const bt = b.dueTime == null ? Infinity : b.dueTime;
        return at - bt || String(a.basename).localeCompare(String(b.basename), 'zh-CN');
      });
    }
    return list;
  }

  function renderQueue(model, state) {
    const queue = model.queue || [];
    const filtered = filterQueue(queue, state);
    const counts = {
      all: queue.length,
      source: queue.filter(item => item.type === 'source').length,
      extract: queue.filter(item => item.type === 'extract').length,
      card: queue.filter(item => item.type === 'card').length,
      overdue: queue.filter(item => item.isOverdue).length,
    };
    const chips = [
      ['all', copy.queueAll, counts.all],
      ['source', copy.queueReading, counts.source],
      ['extract', copy.queueExtracts, counts.extract],
      ['card', copy.queueCards, counts.card],
      ['overdue', copy.queueOverdue, counts.overdue],
    ];
    const chipRow = el('div', { cls: 'mf-chips' });
    for (const [id, label, count] of chips) {
      chipRow.appendChild(el('button', {
        cls: `mf-chip${state.filter === id ? ' is-active' : ''}`,
        attrs: { type: 'button' },
        dataset: { action: 'filter', filter: id },
      }, [el('span', { text: label }), count ? el('span', { cls: 'mf-chip-count', text: String(count) }) : null]));
    }
    const sort = el('select', { cls: 'mf-sort', attrs: { 'data-role': 'sort', 'aria-label': '队列排序' } });
    for (const [value, label] of [['urgency', copy.sortUrgency], ['priority', copy.sortPriority], ['due', copy.sortDue]]) {
      const option = el('option', { text: label, attrs: { value } });
      if (state.sort === value) option.selected = true;
      sort.appendChild(option);
    }

    const panel = el('section', { cls: 'mf-card mf-panel mf-queue-panel' });
    panel.appendChild(el('div', { cls: 'mf-panel-head mf-panel-head-wrap' }, [
      panelHeading(copy.queue, filtered.length),
      el('div', { cls: 'mf-panel-tools' }, [chipRow, sort]),
    ]));

    if (!queue.length) {
      panel.appendChild(emptyState({
        iconName: 'inbox',
        title: copy.emptyQueueTitle,
        text: copy.emptyQueueText,
        steps: [copy.emptyQueueStep1, copy.emptyQueueStep2, copy.emptyQueueStep3],
        actions: model.demo ? [] : [button({ label: copy.enterDemo, variant: 'secondary', action: 'demo-toggle' })],
      }));
    } else if (!filtered.length) {
      panel.appendChild(emptyState({
        iconName: 'search',
        title: copy.noMatch,
        text: '换个关键词，或清除当前筛选。',
        actions: [button({ label: '清除筛选', variant: 'subtle', action: 'clear-filters' })],
      }));
    } else {
      const rows = el('div', { cls: 'mf-queue' });
      filtered.slice(0, 8).forEach((item, index) => rows.appendChild(renderQueueRow(item, index)));
      panel.appendChild(rows);
      const foot = el('div', { cls: 'mf-panel-foot' });
      if ((state.filter !== 'all' || String(state.query || '').trim()) && filtered.length) {
        foot.appendChild(button({
          label: copy.reviewFiltered(filtered.length),
          iconName: 'play',
          variant: 'secondary',
          action: 'review-filtered',
          data: {
            paths: JSON.stringify(filtered.map(item => item.path).filter(Boolean)),
            label: state.filter === 'overdue' ? '逾期筛选' : '队列筛选',
          },
        }));
      }
      if (filtered.length > 8) {
        foot.appendChild(button({ label: copy.viewAll(filtered.length), variant: 'subtle', action: 'more-queue' }));
      }
      if (foot.children.length) panel.appendChild(foot);
    }
    return panel;
  }

  function renderQueueRow(item, index) {
    const row = el('button', {
      cls: `mf-row${item.isOverdue ? ' is-overdue' : ''}`,
      attrs: { type: 'button', title: `${item.basename}（${typeLabel(item.type)}）` },
      dataset: { action: 'open', path: item.path },
    });
    row.appendChild(el('span', { cls: 'mf-row-index', text: pad2(index + 1) }));
    const editable = item.type !== 'card';
    const prio = el('span', {
      cls: `mf-prio is-${priorityTone(item.priority)}${editable ? ' is-editable' : ''}`,
      title: editable
        ? (item.priority == null ? '点击设置优先级' : `优先级 ${item.priority}（数字越小越优先）；点击修改`)
        : '卡片优先级由 Spaced Repetition 管理',
      attrs: editable ? { role: 'button', tabindex: '0', 'aria-label': '修改优先级' } : null,
    }, [
      el('span', { cls: 'mf-prio-bar' }),
      el('span', { cls: 'mf-prio-text', text: item.priority == null ? copy.noPriority : copy.priorityShort(item.priority) }),
    ]);
    if (editable) {
      const editPriority = event => {
        event.preventDefault();
        event.stopPropagation();
        onAction('queue-priority', { path: item.path });
      };
      prio.addEventListener('click', editPriority);
      prio.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') editPriority(event);
      });
    }
    row.appendChild(prio);
    row.appendChild(el('span', { cls: `mf-row-icon is-${typeClass(item.type)}` }, [icon(typeIcon(item.type), 16)]));
    const sub = item.sourceTitle ? `来源 · ${item.sourceTitle}` : typeLabel(item.type);
    row.appendChild(el('span', { cls: 'mf-row-body' }, [
      el('span', { cls: 'mf-row-title', text: item.basename }),
      el('span', { cls: 'mf-row-sub', text: sub }),
    ]));
    const meta = el('span', { cls: 'mf-row-meta' }, [
      el('span', { cls: `mf-due is-${item.dueTone}`, text: item.dueLabel, title: item.dueTitle }),
    ]);
    if (item.type !== 'card') {
      if (item.interval) meta.appendChild(el('span', { cls: 'mf-meta', text: copy.intervalShort(item.interval) }));
      if (item.aFactor) meta.appendChild(el('span', { cls: 'mf-meta mf-af', text: copy.afShort(formatAF(item.aFactor)) }));
    }
    meta.appendChild(icon('chevronRight', 15, 'mf-row-arrow'));
    row.appendChild(meta);
    return row;
  }

  function renderRhythm(model) {
    const items = model.forecast || [];
    const forecastTotal = items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const panel = el('section', { cls: 'mf-card mf-panel mf-rhythm-panel is-combined', dataset: { section: 'analytics' } });
    panel.appendChild(el('div', { cls: 'mf-panel-head' }, [
      panelHeading(copy.rhythmLoad),
      el('span', { cls: 'mf-panel-count', text: copy.forecastTotal(forecastTotal) }),
    ]));
    const top = el('div', { cls: 'mf-rhythm-top' });
    const streak = Number(model.streak) || 0;
    const reviews = Number(model.reviews14d) || 0;
    top.appendChild(el('div', { cls: 'mf-rhythm-stat' }, [
      el('div', { cls: 'mf-rhythm-value' }, [
        el('span', { cls: 'mf-rhythm-big', text: streak > 0 ? String(streak) : '—' }),
        el('span', { cls: 'mf-rhythm-unit', text: copy.streakUnit }),
      ]),
      el('div', { cls: 'mf-rhythm-label', text: copy.streakLabel }),
    ]));
    top.appendChild(el('div', { cls: 'mf-rhythm-divider' }));
    top.appendChild(el('div', { cls: 'mf-rhythm-stat' }, [
      el('div', { cls: 'mf-rhythm-value' }, [
        el('span', { cls: 'mf-rhythm-mid', text: String(reviews) }),
        el('span', { cls: 'mf-rhythm-unit', text: '次' }),
      ]),
      el('div', { cls: 'mf-rhythm-label', text: copy.reviews14d }),
    ]));
    panel.appendChild(top);
    if (reviews > 0) {
      panel.appendChild(el('div', { cls: 'mf-activity' }, [barChart(model.activity || [], { showValues: false, label: '近 14 天复习活动' })]));
    } else {
      panel.appendChild(el('p', { cls: 'mf-panel-note', text: copy.rhythmEmpty }));
      panel.appendChild(el('div', { cls: 'mf-activity is-muted' }, [barChart(model.activity || [], { showValues: false, label: '近 14 天复习活动' })]));
    }
    panel.appendChild(el('div', { cls: 'mf-rhythm-load' }, [
      el('div', { cls: 'mf-rhythm-load-head' }, [
        el('span', { cls: 'mf-eyebrow', text: copy.forecast }),
        el('span', { cls: 'mf-rhythm-load-total', text: copy.forecastTotal(forecastTotal) }),
      ]),
      el('div', { cls: 'mf-forecast' }, [barChart(items, { showValues: true, label: '未来 7 天负荷' })]),
    ]));
    if (!forecastTotal) panel.appendChild(el('p', { cls: 'mf-panel-note', text: '未来 7 天没有安排。' }));
    return panel;
  }

  function filterTreeNodes(nodes, query) {
    if (!query) return nodes || [];
    const out = [];
    for (const node of nodes || []) {
      const children = filterTreeNodes(node.children, query);
      if (String(node.basename || '').toLowerCase().includes(query) || children.length) {
        out.push({ ...node, children });
      }
    }
    return out;
  }

  function countTreeNodes(nodes) {
    let total = 0;
    for (const node of nodes || []) total += 1 + countTreeNodes(node.children);
    return total;
  }

  function renderTree(model, state) {
    const query = String(state.query || '').trim().toLowerCase();
    const nodes = filterTreeNodes(model.tree || [], query);
    const total = countTreeNodes(model.tree || []);
    const panel = simplePanel({ title: copy.tree, count: total, cls: 'mf-tree-panel' });
    if (!nodes.length) {
      panel.appendChild(el('div', { cls: 'mf-mini-empty' }, [
        icon('tree', 18),
        el('p', { text: query ? copy.noMatch : copy.emptyTree }),
      ]));
      panel.appendChild(el('div', { cls: 'mf-panel-foot' }, [
        button({ label: copy.fullTree, variant: 'subtle', action: 'tree-full' }),
      ]));
      return panel;
    }
    const body = el('div', { cls: 'mf-tree' });
    const renderNode = (node, depth) => {
      const forceOpen = Boolean(query);
      const isExpanded = forceOpen
        || (depth === 0 ? !state.collapsed?.has(node.path) : Boolean(state.expanded?.has(node.path)));
      const row = el('div', { cls: 'mf-tree-row', style: { '--depth': String(depth) } });
      if (node.children && node.children.length) {
        const toggle = button({
          iconName: isExpanded ? 'chevronDown' : 'chevronRight',
          iconOnly: true,
          title: isExpanded ? '收起' : '展开',
          action: 'tree-toggle',
          data: { path: node.path, depth: String(depth) },
          className: 'mf-tree-toggle',
        });
        toggle.setAttribute('aria-expanded', String(isExpanded));
        row.appendChild(toggle);
      } else {
        row.appendChild(el('span', { cls: 'mf-tree-spacer' }));
      }
      row.appendChild(el('button', {
        cls: `mf-tree-label is-${typeClass(node.type)}`,
        attrs: { type: 'button', title: node.basename },
        dataset: { action: 'open-note', path: node.path },
      }, [
        icon(typeIcon(node.type), 14),
        el('span', { cls: 'mf-tree-name', text: node.basename }),
        node.dueCount > 0 ? el('span', { cls: 'mf-tree-due', text: String(node.dueCount) }) : null,
      ]));
      body.appendChild(row);
      if (isExpanded && node.children && node.children.length) {
        for (const child of node.children) renderNode(child, depth + 1);
      }
      if (isExpanded && node.hiddenCount > 0) {
        body.appendChild(el('div', { cls: 'mf-tree-more', style: { '--depth': String(depth + 1) } }, [
          el('span', { text: copy.moreHidden(node.hiddenCount) }),
        ]));
      }
    };
    for (const node of nodes) renderNode(node, 0);
    panel.appendChild(body);
    panel.appendChild(el('div', { cls: 'mf-panel-foot' }, [
      button({ label: copy.fullTree, variant: 'subtle', action: 'tree-full' }),
    ]));
    return panel;
  }

  function renderSources(model) {
    const sources = model.sources || [];
    const panel = simplePanel({ title: copy.sources, count: sources.length, cls: 'mf-sources-panel' });
    if (!sources.length) {
      panel.appendChild(el('div', { cls: 'mf-mini-empty' }, [
        icon('file', 18),
        el('p', { text: copy.emptySources }),
      ]));
      return panel;
    }
    for (const source of sources) {
      const item = el('div', { cls: 'mf-source' });
      const top = el('div', { cls: 'mf-source-top' });
      top.appendChild(el('button', {
        cls: 'mf-source-title',
        attrs: { type: 'button', title: source.basename },
        dataset: { action: 'open-note', path: source.path },
      }, [
        icon('book', 14),
        el('span', { text: source.basename }),
      ]));
      if (source.hasPdf) {
        top.appendChild(button({
          label: copy.openPdf,
          iconName: 'file',
          variant: 'subtle',
          action: 'open-pdf',
          data: { path: source.path },
          className: 'mf-pdf-btn',
        }));
      }
      item.appendChild(top);
      item.appendChild(el('div', { cls: 'mf-source-meta' }, [
        el('span', { text: copy.pages(source.readPoint || 0, source.totalPages) }),
        el('span', { cls: 'mf-dot-sep' }),
        el('span', { text: copy.extracts(source.extractCount) }),
      ]));
      item.appendChild(progressBar(source.progress, 'accent'));
      panel.appendChild(item);
    }
    return panel;
  }

  function renderQuickActions() {
    const panel = simplePanel({ title: copy.quick, cls: 'mf-quick-panel' });
    const grid = el('div', { cls: 'mf-quick-grid' });
    const items = [
      { action: 'quick-card', iconName: 'card', title: copy.quickCard, desc: copy.quickCardDesc },
      { action: 'quick-extract', iconName: 'extract', title: copy.quickExtract, desc: copy.quickExtractDesc },
      { action: 'quick-new', iconName: 'plus', title: copy.quickNew, desc: copy.quickNewDesc },
    ];
    for (const item of items) {
      grid.appendChild(el('button', {
        cls: 'mf-quick',
        attrs: { type: 'button' },
        dataset: { action: item.action },
      }, [
        el('span', { cls: 'mf-quick-icon' }, [icon(item.iconName, 17)]),
        el('span', { cls: 'mf-quick-title', text: item.title }),
        el('span', { cls: 'mf-quick-desc', text: item.desc }),
      ]));
    }
    panel.appendChild(grid);
    return panel;
  }

  function renderRecent(model) {
    const recent = model.recent || [];
    if (!recent.length) return null;
    const panel = simplePanel({ title: copy.recent, count: recent.length, cls: 'mf-recent-panel' });
    const grid = el('div', { cls: 'mf-recent' });
    for (const item of recent) {
      const buttonNode = el('button', {
        cls: 'mf-quote',
        attrs: { type: 'button', title: item.title || item.basename },
        dataset: { action: 'open', path: item.path },
      });
      buttonNode.appendChild(el('span', { cls: 'mf-quote-text', text: item.text || '（正文为空）' }));
      const meta = [item.sourceTitle || item.title];
      if (item.page) meta.push(`第 ${item.page} 页`);
      buttonNode.appendChild(el('span', { cls: 'mf-quote-meta', text: meta.filter(Boolean).join(' · ') }));
      grid.appendChild(buttonNode);
    }
    panel.appendChild(grid);
    return panel;
  }

  function menuItem(iconName, label, action) {
    return el('button', {
      cls: 'mf-menu-item',
      attrs: { type: 'button' },
      dataset: { action },
    }, [icon(iconName, 15), el('span', { text: label })]);
  }

  function menuItemWithLabel(iconName, label, action, labelEl) {
    return el('button', {
      cls: 'mf-menu-item',
      attrs: { type: 'button' },
      dataset: { action },
    }, [icon(iconName, 15), labelEl]);
  }

  function toggleMenu(force) {
    menuOpen = force != null ? force : !menuOpen;
    menu.hidden = !menuOpen;
    moreButton.classList.toggle('is-active', menuOpen);
    moreButton.setAttribute('aria-expanded', String(menuOpen));
  }

  function closeMenu() {
    if (menuOpen) toggleMenu(false);
  }

  function handleClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'menu') {
      event.preventDefault();
      event.stopPropagation();
      toggleMenu();
      return;
    }
    closeMenu();
    const data = { ...target.dataset };
    try {
      onAction(action, data);
    } catch (error) {
      console.error('[MemoFlow] action failed', action, error);
    }
  }

  function handleInput(event) {
    const input = event.target.closest('[data-role="search"]');
    if (!input) return;
    onAction('search', { query: input.value });
  }

  function handleChange(event) {
    const select = event.target.closest('[data-role="sort"]');
    if (!select) return;
    onAction('sort', { sort: select.value });
  }

  function handleKeydown(event) {
    if (!root.isConnected) return;
    const metaKey = event.metaKey || event.ctrlKey;
    if (metaKey && String(event.key).toLowerCase() === 'k') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (event.key === 'Escape') {
      if (menuOpen) {
        closeMenu();
        return;
      }
      if (document.activeElement === searchInput) {
        if (searchInput.value) {
          searchInput.value = '';
          onAction('search', { query: '' });
        } else {
          searchInput.blur();
        }
      }
    }
  }

  function handleDocumentClick(event) {
    if (!menuOpen) return;
    if (menuWrap.contains(event.target)) return;
    closeMenu();
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  root.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('click', handleDocumentClick);

  function scrollToAnalytics() {
    const section = root.querySelector('[data-section="analytics"]');
    if (section && typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function setSearchValue(value) {
    searchInput.value = value == null ? '' : String(value);
  }

  function destroy() {
    document.removeEventListener('keydown', handleKeydown);
    document.removeEventListener('click', handleDocumentClick);
    root.remove();
  }

  return {
    root,
    update,
    updateLists,
    setLoading,
    setError,
    scrollToAnalytics,
    setSearchValue,
    destroy,
  };
}

module.exports = { createDashboard };
