'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { cleanPath, targetPage, resolveMobilePdfTarget } = require('../src/platform/pdf.js');

function hasVaultFile(path) {
  return path === 'test/学会提问.pdf' || path === 'notes/book with space.pdf';
}

test('cleanPath tolerates wikilinks, aliases and page fragments', () => {
  assert.equal(cleanPath('[[test/学会提问.pdf#page=3|书]]'), 'test/学会提问.pdf');
  assert.equal(cleanPath('/test/学会提问.pdf'), 'test/学会提问.pdf');
  assert.equal(cleanPath(''), '');
});

test('targetPage clamps read_point into the chapter range', () => {
  assert.equal(targetPage({ read_point: 20, page_start: 10, page_end: 30 }), 20);
  assert.equal(targetPage({ read_point: 3, page_start: 10, page_end: 30 }), 10);
  assert.equal(targetPage({ read_point: 80, page_start: 10, page_end: 30 }), 30);
  assert.equal(targetPage({}), 1);
});

test('resolves pdf_vault_path first', () => {
  const target = resolveMobilePdfTarget({
    pdf_vault_path: 'test/学会提问.pdf',
    pdf_path: '/Users/me/Desktop/outside.pdf',
    read_point: 12,
  }, hasVaultFile);
  assert.deepEqual(target, { ok: true, path: 'test/学会提问.pdf', page: 12 });
});

test('falls back to a vault-relative pdf_path', () => {
  const target = resolveMobilePdfTarget({
    pdf_path: 'notes/book with space.pdf',
    page_start: 4,
    page_end: 9,
  }, hasVaultFile);
  assert.equal(target.ok, true);
  assert.equal(target.path, 'notes/book with space.pdf');
  assert.equal(target.page, 4);
});

test('rejects an external PDF with a clear mobile message', () => {
  const target = resolveMobilePdfTarget({
    pdf_path: '/Users/me/Desktop/book.pdf',
  }, hasVaultFile);
  assert.equal(target.ok, false);
  assert.equal(target.code, 'external');
  assert.ok(target.message.includes('pdf_vault_path'));
});

test('rejects a source without a PDF path', () => {
  const target = resolveMobilePdfTarget({ type: 'source' }, hasVaultFile);
  assert.equal(target.ok, false);
  assert.equal(target.code, 'no-path');
});
