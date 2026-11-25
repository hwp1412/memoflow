'use strict';

// Synthetic migration fixtures (PR-08). No real vault content is used.

function uuid(seq) {
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function serialize(fields, body) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value === null ? 'null' : value}`);
  return ['---', ...lines, '---', body].join('\n');
}

function note(overrides = {}) {
  const {
    path = 'Sources/A.md',
    basename = 'A',
    type = 'source',
    status = 'active',
    priority = 50,
    interval = 8,
    aFactor = 2.0,
    reviewCount = 0,
    nextReview = '24-11-2026',
    lastReviewed = '',
    mfId = null,
    extra = {},
    body = 'Body text\nsecond line',
    revision = null,
  } = overrides;

  const fields = {
    type,
    status,
    priority,
    interval,
    a_factor: aFactor,
    review_count: reviewCount,
    next_review: nextReview,
    last_reviewed: lastReviewed,
    ...extra,
  };
  if (mfId) fields.mf_id = mfId;

  const content = serialize(fields, body);
  const raw = {
    type,
    status,
    priority,
    interval,
    a_factor: aFactor,
    review_count: reviewCount,
    next_review: nextReview,
    last_reviewed: lastReviewed,
    path,
    basename,
    content,
    ...(mfId ? { mf_id: mfId } : {}),
    ...extra,
  };
  return { raw, content, revision };
}

function allocator(prefix = '11111111-1111-4111-8111-') {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `${prefix}${String(sequence).padStart(12, '0')}`;
  };
}

module.exports = { uuid, serialize, note, allocator };
