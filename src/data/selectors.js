'use strict';

const dateCore = require('../../date-core.js');
const treeCore = require('../../tree-core.js');
const text = require('./text.js');

const DONE_STATUSES = new Set(['done', 'container', 'dismissed']);

function configuredDateFormat(settings) {
  return dateCore.normalizeDateFormat(settings && settings.misc && settings.misc.date_format);
}

function parseDateValue(value, settings) {
  return dateCore.parseDate(value, configuredDateFormat(settings));
}

function formatDateValue(date, settings) {
  return dateCore.formatDate(date, configuredDateFormat(settings));
}

function todayDate(now = new Date()) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function isTracked(fm) {
  if (!fm) return false;
  if (!['source', 'extract', 'card'].includes(fm.type)) return false;
  return !DONE_STATUSES.has(fm.status);
}

function isTopic(fm) {
  return Boolean(fm) && (fm.type === 'source' || fm.type === 'extract');
}

function isCard(fm) {
  return Boolean(fm) && fm.type === 'card';
}

function hasSchedule(fm, settings) {
  return Boolean(fm && parseDateValue(fm.next_review, settings));
}

function isDue(fm, today, settings) {
  if (!isTopic(fm)) return false;
  const due = parseDateValue(fm && fm.next_review, settings);
  return Boolean(due && due.getTime() <= today.getTime());
}

function isOverdue(fm, today, settings) {
  if (!isTopic(fm)) return false;
  const due = parseDateValue(fm && fm.next_review, settings);
  return Boolean(due && due.getTime() < today.getTime());
}

function priorityNumber(fm) {
  const n = Number(fm && fm.priority);
  return Number.isFinite(n) ? n : null;
}

function urgency(fm, today, settings) {
  const pri = priorityNumber(fm) == null ? 0 : (101 - priorityNumber(fm)) * 10;
  const due = parseDateValue(fm && fm.next_review, settings);
  if (!due) return pri;
  const diff = text.daysBetween(today, due);
  let value = pri + diff * 2;
  if (diff >= 0) value += 5000;
  return value;
}

function dueMeta(fm, today, settings) {
  if (isCard(fm)) {
    return {
      dueDate: null,
      dueTime: null,
      dueLabel: '卡片',
      dueTitle: '卡片复习由 Spaced Repetition 管理',
      dueTone: 'card',
      isOverdue: false,
    };
  }
  const dueDate = parseDateValue(fm && fm.next_review, settings);
  if (!dueDate) {
    const isNew = !DONE_STATUSES.has(fm && fm.status);
    return {
      dueDate: null,
      dueTime: null,
      dueLabel: isNew ? '新素材' : '未排期',
      dueTitle: '还没有安排下次复习',
      dueTone: isNew ? 'new' : 'muted',
      isOverdue: false,
    };
  }
  const diff = text.daysBetween(dueDate, today);
  return {
    dueDate,
    dueTime: dueDate.getTime(),
    dueLabel: text.formatRelativeDay(dueDate, today),
    dueTitle: formatDateValue(dueDate, settings),
    dueTone: diff < 0 ? 'overdue' : (diff === 0 ? 'today' : 'future'),
    isOverdue: diff < 0,
  };
}

function sourceTitleFor(fm) {
  return treeCore.linkTargetName((fm && fm.source) || (fm && fm.parent)) || '';
}

function queueItem(row, today, settings) {
  const fm = row && row.fm;
  if (!isTracked(fm)) return null;
  if (!isTopic(fm) && !isCard(fm)) return null;
  const due = dueMeta(fm, today, settings);
  return {
    path: row.tfile ? row.tfile.path : (row.path || ''),
    basename: row.tfile ? row.tfile.basename : (row.basename || ''),
    type: fm.type,
    sourceTitle: sourceTitleFor(fm),
    priority: priorityNumber(fm),
    interval: Number(fm.interval) > 0 ? Number(fm.interval) : null,
    aFactor: Number(fm.a_factor) > 0 ? Number(fm.a_factor) : null,
    status: fm.status || '',
    dueDate: due.dueDate,
    dueTime: due.dueTime,
    dueLabel: due.dueLabel,
    dueTitle: due.dueTitle,
    dueTone: due.dueTone,
    isOverdue: due.isOverdue,
    hasPdf: Boolean(fm.pdf_vault_path || fm.pdf_path),
    urgency: urgency(fm, today, settings),
    tfile: row.tfile || null,
    fm,
  };
}

function buildQueue(rows, today, settings) {
  const items = [];
  for (const row of rows || []) {
    const item = queueItem(row, today, settings);
    if (item) items.push(item);
  }
  items.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    const ap = a.priority == null ? 101 : a.priority;
    const bp = b.priority == null ? 101 : b.priority;
    if (ap !== bp) return ap - bp;
    return a.basename.localeCompare(b.basename, 'zh-CN');
  });
  return items;
}

function buildCounts(rows, today, settings) {
  let due = 0;
  let overdue = 0;
  let todayDue = 0;
  let newItems = 0;
  let cards = 0;
  let reviewedToday = 0;
  for (const row of rows || []) {
    const fm = row && row.fm;
    if (!isTracked(fm)) continue;
    if (isCard(fm)) {
      cards++;
    } else if (isTopic(fm)) {
      const scheduled = parseDateValue(fm.next_review, settings);
      if (!scheduled) newItems++;
      else {
        const diff = text.daysBetween(scheduled, today);
        if (diff < 0) {
          due++;
          overdue++;
        } else if (diff === 0) {
          due++;
          todayDue++;
        }
      }
    }
    const reviewed = parseDateValue(fm.last_reviewed, settings);
    if (reviewed && reviewed.getTime() === today.getTime()) reviewedToday++;
  }
  return { due, overdue, todayDue, newItems, cards, reviewedToday };
}

function buildForecast(rows, today, settings, days = 7) {
  const counts = new Array(days).fill(0);
  for (const row of rows || []) {
    const fm = row && row.fm;
    if (!isTopic(fm) || !isTracked(fm)) continue;
    const scheduled = parseDateValue(fm.next_review, settings);
    if (!scheduled) continue;
    let offset = text.daysBetween(scheduled, today);
    if (offset < 0) offset = 0;
    if (offset >= days) continue;
    counts[offset]++;
  }
  return counts.map((count, index) => {
    const date = new Date(today.getTime());
    date.setDate(date.getDate() + index);
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    return {
      label: index === 0 ? '今天' : `周${weekday}`,
      shortLabel: index === 0 ? '今天' : `周${weekday}`,
      count,
      isToday: index === 0,
    };
  });
}

function parseReviewLog(content, settings) {
  const entries = [];
  const lines = String(content || '').split('\n');
  for (const line of lines) {
    const match = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (!match) continue;
    const value = match[1].trim();
    if (!value || value === 'Date' || /^-+$/.test(value)) continue;
    const date = parseDateValue(value, settings);
    if (!date) continue;
    entries.push({ date, key: dateCore.formatDate(date, 'YYYY-MM-DD') });
  }
  return entries;
}

function buildActivity(entries, today, days = 14) {
  const counts = new Map();
  for (const entry of entries || []) {
    counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
  }
  const items = [];
  let total = 0;
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime());
    date.setDate(date.getDate() - offset);
    const key = dateCore.formatDate(date, 'YYYY-MM-DD');
    const count = counts.get(key) || 0;
    total += count;
    items.push({
      key,
      label: offset === 0 ? '今天' : text.formatShortDate(date),
      count,
      isToday: offset === 0,
    });
  }
  return { items, total };
}

function computeStreak(entries, today) {
  const keys = new Set((entries || []).map(entry => entry.key));
  if (!keys.size) return 0;
  let cursor = new Date(today.getTime());
  let cursorKey = dateCore.formatDate(cursor, 'YYYY-MM-DD');
  if (!keys.has(cursorKey)) {
    cursor.setDate(cursor.getDate() - 1);
    cursorKey = dateCore.formatDate(cursor, 'YYYY-MM-DD');
    if (!keys.has(cursorKey)) return 0;
  }
  let streak = 0;
  while (keys.has(cursorKey) && streak < 4000) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
    cursorKey = dateCore.formatDate(cursor, 'YYYY-MM-DD');
  }
  return streak;
}

function buildSources(rows, settings) {
  const extractCount = new Map();
  for (const row of rows || []) {
    const fm = row && row.fm;
    if (!fm || fm.type !== 'extract') continue;
    const source = treeCore.linkTargetName(fm.source || fm.parent);
    if (!source) continue;
    const key = source.toLowerCase();
    extractCount.set(key, (extractCount.get(key) || 0) + 1);
  }
  const sources = [];
  for (const row of rows || []) {
    const fm = row && row.fm;
    if (!fm || fm.type !== 'source' || !isTracked(fm)) continue;
    const totalPages = Number(fm.total_pages) > 0 ? Math.floor(Number(fm.total_pages)) : null;
    const readPoint = Number(fm.read_point) > 0 ? Math.floor(Number(fm.read_point)) : totalPages ? 1 : null;
    const progress = totalPages && readPoint ? Math.min(1, Math.max(0, readPoint / totalPages)) : 0;
    const last = parseDateValue(fm.last_reviewed || fm.date_added, settings);
    sources.push({
      path: row.tfile ? row.tfile.path : '',
      basename: row.tfile ? row.tfile.basename : '',
      type: 'source',
      readPoint,
      totalPages,
      progress,
      extractCount: extractCount.get(String(row.tfile ? row.tfile.basename : '').toLowerCase()) || 0,
      hasPdf: Boolean(fm.pdf_vault_path || fm.pdf_path),
      lastReviewed: last ? last.getTime() : 0,
      tfile: row.tfile || null,
      fm,
    });
  }
  sources.sort((a, b) => {
    if (a.hasPdf !== b.hasPdf) return a.hasPdf ? -1 : 1;
    if (b.lastReviewed !== a.lastReviewed) return b.lastReviewed - a.lastReviewed;
    if (b.progress !== a.progress) return b.progress - a.progress;
    return a.basename.localeCompare(b.basename, 'zh-CN');
  });
  return sources.slice(0, 3);
}

function buildTree(index, today, settings, limit = 8) {
  if (!index || !Array.isArray(index.roots)) return [];
  const memo = new Map();
  const visiting = new Set();

  function aggregateDue(page) {
    if (!page || !page.path) return 0;
    if (memo.has(page.path)) return memo.get(page.path);
    if (visiting.has(page.path)) return 0;
    visiting.add(page.path);
    let count = isTopic(page.fm) && isDue(page.fm, today, settings) ? 1 : 0;
    const children = index.childrenOf.get(String(page.basename).toLowerCase()) || [];
    for (const child of children) count += aggregateDue(child);
    visiting.delete(page.path);
    memo.set(page.path, count);
    return count;
  }

  function buildNode(page, depth, seen) {
    if (!page || seen.has(page.path)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(page.path);
    const allChildren = (index.childrenOf.get(String(page.basename).toLowerCase()) || [])
      .filter(child => !nextSeen.has(child.path));
    const visibleChildren = [];
    if (depth < 2) {
      for (const child of allChildren.slice(0, limit)) {
        const built = buildNode(child, depth + 1, nextSeen);
        if (built) visibleChildren.push(built);
      }
    }
    return {
      path: page.path,
      basename: page.basename,
      type: page.fm && page.fm.type ? page.fm.type : 'source',
      dueCount: aggregateDue(page),
      children: visibleChildren,
      hasChildren: allChildren.length > 0,
      hiddenCount: Math.max(0, allChildren.length - visibleChildren.length),
      tfile: page.tfile || null,
      fm: page.fm || null,
    };
  }

  const seen = new Set();
  const nodes = [];
  for (const root of index.roots) {
    const node = buildNode(root, 0, seen);
    if (node) nodes.push(node);
  }
  return nodes;
}

module.exports = {
  DONE_STATUSES,
  configuredDateFormat,
  parseDateValue,
  formatDateValue,
  todayDate,
  isTracked,
  isTopic,
  isCard,
  hasSchedule,
  isDue,
  isOverdue,
  priorityNumber,
  urgency,
  dueMeta,
  queueItem,
  buildQueue,
  buildCounts,
  buildForecast,
  parseReviewLog,
  buildActivity,
  computeStreak,
  buildSources,
  buildTree,
};
