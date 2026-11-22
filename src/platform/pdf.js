'use strict';

/**
 * Obsidian mobile has no Node `fs`/`url` and its vault adapter is not a
 * FileSystemAdapter. The desktop plugin opens PDFs through a filesystem path;
 * on mobile we may only open files that live inside the vault, via Obsidian's
 * native PDF viewer and a `#page=N` link.
 *
 * This module is deliberately pure: the caller injects `hasVaultFile()` so the
 * logic can be unit-tested without Obsidian.
 */

function cleanPath(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return '';
  // Tolerate wikilinks and aliases left in frontmatter.
  s = s.replace(/^\[\[/, '').replace(/\]\]$/, '');
  s = s.split('|')[0];
  s = s.split('#')[0];
  return s.trim().replace(/^\/+/, '');
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function targetPage(fm) {
  const start = positiveInt(fm && fm.page_start);
  const end = positiveInt(fm && fm.page_end);
  const readPoint = positiveInt(fm && fm.read_point);
  let page = readPoint || start || 1;
  if (start && end && end >= start) page = Math.max(start, Math.min(page, end));
  return page;
}

/**
 * @param {object|null} fm source frontmatter
 * @param {(path: string) => boolean} hasVaultFile
 * @returns {{ok: true, path: string, page: number} | {ok: false, code: string, message: string}}
 */
function resolveMobilePdfTarget(fm, hasVaultFile) {
  if (!fm || typeof hasVaultFile !== 'function') {
    return { ok: false, code: 'no-source', message: '当前文件不是 Incremental Reading 来源笔记。' };
  }
  const candidates = [cleanPath(fm.pdf_vault_path), cleanPath(fm.pdf_path)].filter(Boolean);
  if (!candidates.length) {
    return { ok: false, code: 'no-path', message: '来源没有设置 PDF 路径。' };
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (hasVaultFile(candidate)) {
      return { ok: true, path: candidate, page: targetPage(fm) };
    }
  }
  return {
    ok: false,
    code: 'external',
    message: '移动端仅支持 Vault 内 PDF。请在来源里设置 pdf_vault_path（Vault 相对路径）。',
  };
}

module.exports = { cleanPath, targetPage, resolveMobilePdfTarget };
