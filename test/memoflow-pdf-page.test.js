const test = require('node:test');
const assert = require('node:assert/strict');
const { currentPageNumber } = require('../src/data/pdf-page.js');

test('reads the native PDF viewer current page', () => {
  assert.equal(currentPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 37 } } } }), 37);
});

test('falls back to PDF.js location page number', () => {
  assert.equal(currentPageNumber({ viewer: { child: { pdfViewer: { _location: { pageNumber: 12 } } } } }), 12);
});

test('returns null for missing or invalid page numbers', () => {
  assert.equal(currentPageNumber(null), null);
  assert.equal(currentPageNumber({}), null);
  assert.equal(currentPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 0 } } } }), null);
});
