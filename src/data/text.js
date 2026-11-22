'use strict';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stripFrontmatter(content) {
  const text = String(content == null ? '' : content);
  if (!text.startsWith('---')) return text;
  const firstBreak = text.indexOf('\n');
  if (firstBreak === -1) return text;
  const closing = text.indexOf('\n---', firstBreak);
  if (closing === -1) return text;
  return text.slice(closing + 4).replace(/^\r?\n/, '');
}

function stripMarkdown(content) {
  let text = String(content == null ? '' : content);
  text = stripFrontmatter(text);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  text = text.replace(/!\[\[([^\]]+)\]\]/g, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*\[![^\]]+\][+-]?/gm, '');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/==(.*?)==/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, ' ');
  text = text.replace(/📍|<!--ir-readpoint-->/g, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, ' ');
  return text.trim();
}

function extractExcerpt(content, maxLength = 180) {
  const text = stripMarkdown(content);
  if (!text) return '';
  const limit = Math.max(20, Number(maxLength) || 180);
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastBreak = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('；'));
  const cut = lastBreak >= Math.floor(limit * 0.55) ? slice.slice(0, lastBreak + 1) : slice;
  return cut.replace(/[，、；：,;:\s]+$/, '') + '…';
}

function formatDateLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAYS[d.getDay()]}`;
}

function formatShortDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfDay(value) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
}

function formatRelativeDay(date, today) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '未排期';
  const diff = daysBetween(date, today);
  if (diff === 0) return '今天';
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`;
  if (diff === 1) return '明天';
  if (diff <= 14) return `${diff} 天后`;
  return formatShortDate(date);
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value === 0) return '不到 1 分钟';
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
  } catch (error) {
    return String(Number(value) || 0);
  }
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(clamp(n, 0, 1) * 100);
}

module.exports = {
  WEEKDAYS,
  clamp,
  pad2,
  stripFrontmatter,
  stripMarkdown,
  extractExcerpt,
  formatDateLabel,
  formatShortDate,
  startOfDay,
  daysBetween,
  formatRelativeDay,
  formatMinutes,
  formatNumber,
  percent,
};
