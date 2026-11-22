'use strict';

const dateCore = require('../../date-core.js');
const selectors = require('./selectors.js');
const text = require('./text.js');
const { buildDemoModel } = require('./demo.js');

function readText(plugin, file, cache) {
  if (!file || !plugin?.app?.vault?.cachedRead) return Promise.resolve('');
  if (cache.has(file.path)) return cache.get(file.path);
  const promise = plugin.app.vault.cachedRead(file).catch(() => '');
  cache.set(file.path, promise);
  return promise;
}

function sortRecentExtracts(rows, today, settings) {
  return (rows || [])
    .filter(row => row?.fm?.type === 'extract' && selectors.isTracked(row.fm))
    .map(row => {
      const added = selectors.parseDateValue(row.fm.date_added, settings);
      const reviewed = selectors.parseDateValue(row.fm.last_reviewed, settings);
      return { row, score: (added ? added.getTime() : 0) + (reviewed ? reviewed.getTime() / 1000 : 0) };
    })
    .sort((a, b) => b.score - a.score || String(a.row.tfile?.basename || '').localeCompare(String(b.row.tfile?.basename || ''), 'zh-CN'))
    .slice(0, 3)
    .map(entry => entry.row);
}

function pageForExtract(fm) {
  for (const key of ['page', 'read_point', 'page_start']) {
    const n = Number(fm && fm[key]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

async function readReviewLog(plugin) {
  try {
    const path = plugin?.reviewLogPath?.();
    if (!path || !plugin?.app?.vault) return '';
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') return '';
    const content = await plugin.app.vault.cachedRead(file);
    return String(content || '');
  } catch (error) {
    console.warn('[MemoFlow] could not read review log', error);
    return '';
  }
}

async function buildModel({ plugin, isMobile = false, demo = false, today: todayInput = new Date() } = {}) {
  const today = selectors.todayDate(todayInput);
  if (demo) return buildDemoModel(today, { isMobile });

  const settings = (plugin && plugin.settings) || {};
  const rows = (plugin && typeof plugin.getIRRows === 'function' ? plugin.getIRRows() : []) || [];
  const counts = selectors.buildCounts(rows, today, settings);
  const srReady = Boolean(plugin && typeof plugin.isSpacedRepetitionReady === 'function' && plugin.isSpacedRepetitionReady());
  let cardsDue = 0;
  if (srReady && typeof plugin._cardIsDue === 'function') {
    const cardRows = rows
      .filter(row => row?.fm?.type === 'card' && selectors.isTracked(row.fm))
      .slice(0, 500);
    const flags = await Promise.all(cardRows.map(async row => {
      try {
        return await plugin._cardIsDue(row.tfile, today);
      } catch {
        return false;
      }
    }));
    cardsDue = flags.filter(Boolean).length;
  }
  counts.cardsDue = cardsDue;
  const queue = selectors.buildQueue(rows, today, settings);
  const tree = plugin && typeof plugin.buildTreeIndex === 'function'
    ? selectors.buildTree(plugin.buildTreeIndex(), today, settings)
    : [];
  const sources = selectors.buildSources(rows, settings);
  const forecast = selectors.buildForecast(rows, today, settings, 7);

  const rawLog = await readReviewLog(plugin);
  const logTail = rawLog ? rawLog.split('\n').slice(-5000).join('\n') : '';
  const entries = selectors.parseReviewLog(logTail, settings);
  const activityResult = selectors.buildActivity(entries, today, 14);
  const streak = selectors.computeStreak(entries, today);
  const todayKey = dateCore.formatDate(today, 'YYYY-MM-DD');
  const reviewsTodayFromLog = entries.filter(entry => entry.key === todayKey).length;
  counts.reviewedToday = Math.max(counts.reviewedToday, reviewsTodayFromLog);

  const cache = new Map();
  const primary = queue.find(item => item.type !== 'card') || queue[0] || null;
  if (primary && primary.tfile && primary.type !== 'card') {
    const content = await readText(plugin, primary.tfile, cache);
    primary.excerpt = text.extractExcerpt(content, 180);
  }

  const recentRows = sortRecentExtracts(rows, today, settings);
  const recent = [];
  for (const row of recentRows) {
    const content = await readText(plugin, row.tfile, cache);
    const sourceName = row.fm && row.fm.source ? String(row.fm.source) : '';
    recent.push({
      path: row.tfile ? row.tfile.path : '',
      basename: row.tfile ? row.tfile.basename : '',
      title: row.tfile ? row.tfile.basename : '',
      sourceTitle: sourceName.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0],
      page: pageForExtract(row.fm),
      text: text.extractExcerpt(content, 150),
      tfile: row.tfile || null,
      fm: row.fm || null,
    });
  }

  const totalForProgress = counts.reviewedToday + counts.due;
  const progress = totalForProgress <= 0 ? 1 : Math.min(1, counts.reviewedToday / totalForProgress);
  const estimatedMinutes = counts.due <= 0 ? 0 : Math.max(5, Math.round((counts.due * 1.5) / 5) * 5);

  return {
    today,
    dateLabel: text.formatDateLabel(today),
    counts,
    progress,
    estimatedMinutes,
    hero: { primary },
    queue,
    tree,
    forecast,
    activity: activityResult.items,
    streak,
    reviews14d: activityResult.total,
    sources,
    recent,
    demo: false,
    srReady,
    isMobile,
  };
}

module.exports = { buildModel };
