'use strict';

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * A timestamp title is intentionally disposable: the excerpt body and its
 * source link matter, the filename does not.
 */
function timestampTitle(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Pull a page + optional PDF++ selection parameters out of a copied selection.
 * Supports both a full [[file.pdf#page=12&selection=...]] link and a bare
 * `#page=12` fragment.
 */
function parsePdfSelection(text) {
  const source = String(text == null ? '' : text);
  const link = source.match(/\[\[([^\]|#]+)#page=(\d+)([^\]|]*)(?:\|[^\]]*)?\]\]/);
  if (link) {
    return {
      target: link[1].trim(),
      page: Number(link[2]),
      params: link[3] || '',
    };
  }
  const page = source.match(/#page=(\d+)/);
  if (page) return { target: null, page: Number(page[1]), params: '' };
  return { target: null, page: null, params: '' };
}

function buildCitation({ sourceTitle, pdfPath = null, page = null, params = '' }) {
  const title = String(sourceTitle || '来源');
  const target = pdfPath ? String(pdfPath) : title;
  const suffix = page ? `#page=${page}${params || ''}` : '';
  const label = page ? `${title} · p.${page}` : title;
  return `[[${target}${suffix}|${label}]]`;
}

function cleanExtractBody(body) {
  let text = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  const firstIndex = lines.findIndex(line => line.trim());
  if (firstIndex < 0) return '';
  const first = lines[firstIndex].trim();
  // Copied PDF callouts (PDF Mark Link / PDF++) look like `> [!PDF] ...`.
  if (/^>\s*\[![^\]]+\]/.test(first)) {
    return lines
      .slice(firstIndex + 1)
      .map(line => line.replace(/^>\s?/, ''))
      .filter(line => !/^来源[:：]/.test(line.trim()))
      .join('\n')
      .trim();
  }
  return text;
}

function buildExtractContent({
  sourceTitle,
  parentTitle = null,
  body,
  priority,
  interval,
  nextReview,
  dateAdded,
  page = null,
  citation,
}) {
  const lines = [
    '---',
    'type: extract',
    `source: ${JSON.stringify(`[[${sourceTitle}]]`)}`,
    ...(parentTitle ? [`parent: ${JSON.stringify(`[[${parentTitle}]]`)}`] : []),
    'status: pending',
    `priority: ${priority}`,
    `next_review: ${nextReview}`,
    `interval: ${interval}`,
    'a_factor: 2.0',
    'review_count: 0',
    'last_reviewed:',
    `date_added: ${dateAdded}`,
  ];
  if (page != null) lines.push(`page: ${page}`);
  lines.push('tags:', '  - incremental-reading', '  - ir/extract', '---', '');
  const text = cleanExtractBody(body);
  const footer = citation ? `\n\n---\n\n**来源**：${citation}` : '';
  lines.splice(lines.indexOf('tags:'), 0, 'cssclasses:', '  - memoflow-extract');
  return lines.join('\n') + text + footer + '\n';
}

module.exports = { timestampTitle, parsePdfSelection, buildCitation, buildExtractContent, cleanExtractBody };
