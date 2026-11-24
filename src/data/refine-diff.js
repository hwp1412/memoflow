'use strict';

const DEFAULT_MAX_CELLS = 160000;
const DEFAULT_MAX_LINES = 1200;

function splitLines(text) {
  return String(text == null ? '' : text).split('\n').map(line => line.replace(/\r$/, ''));
}

function coarseDiff(beforeLines, afterLines) {
  const rows = [];
  if (beforeLines.length) rows.push({ type: 'del', text: beforeLines.join('\n') });
  if (afterLines.length) rows.push({ type: 'ins', text: afterLines.join('\n') });
  return rows;
}

// Line-level diff for display only. It never returns HTML, and falls back to a
// bounded coarse replacement for very large inputs. This is intentionally not
// a merge engine and does not modify content.
function diffLines(before, after, { maxCells = DEFAULT_MAX_CELLS, maxLines = DEFAULT_MAX_LINES } = {}) {
  const left = splitLines(before);
  const right = splitLines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix++;

  const rows = left.slice(0, prefix).map(text => ({ type: 'equal', text }));
  const middleLeft = left.slice(prefix, left.length - suffix);
  const middleRight = right.slice(prefix, right.length - suffix);
  if (middleLeft.length * middleRight.length > maxCells
    || middleLeft.length + middleRight.length > maxLines) {
    rows.push(...coarseDiff(middleLeft, middleRight));
  } else {
    const n = middleLeft.length;
    const m = middleRight.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = middleLeft[i] === middleRight[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (middleLeft[i] === middleRight[j]) {
        rows.push({ type: 'equal', text: middleLeft[i] });
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        rows.push({ type: 'del', text: middleLeft[i] });
        i++;
      } else {
        rows.push({ type: 'ins', text: middleRight[j] });
        j++;
      }
    }
    while (i < n) rows.push({ type: 'del', text: middleLeft[i++] });
    while (j < m) rows.push({ type: 'ins', text: middleRight[j++] });
  }
  rows.push(...left.slice(left.length - suffix).map(text => ({ type: 'equal', text })));
  return rows;
}

function diffStats(rows) {
  const stats = { added: 0, removed: 0, equal: 0 };
  for (const row of rows || []) {
    if (row.type === 'ins') stats.added++;
    else if (row.type === 'del') stats.removed++;
    else if (row.type === 'equal') stats.equal++;
  }
  return stats;
}

module.exports = { diffLines, diffStats, splitLines };
