'use strict';

// PR-08 — migration preview (SPEC A2, A10.2).

const test = require('node:test');
const assert = require('node:assert/strict');

const { previewMigration } = require('../src/scheduling/index.js');
const { uuid, note } = require('./helpers/migration-fixtures.js');

const CONTEXT = { dateFormat: 'DD-MM-YYYY' };

test('a legal legacy Source is migratable and keeps its effective due', () => {
  const { raw } = note({ mfId: uuid(1) });
  const plan = previewMigration([raw], CONTEXT, { snapshotId: 'snap-1' });
  assert.equal(plan.kind, 'mf-us-1-migration-plan');
  assert.equal(plan.writesPerformed, false);
  assert.equal(plan.summary.total, 1);
  assert.equal(plan.summary.migratable, 1);
  const entry = plan.entries[0];
  assert.equal(entry.status, 'migratable');
  assert.equal(entry.effectiveDuePreserved, true);
  assert.equal(entry.before.effectiveDue, '2026-11-24');
  assert.equal(entry.after.effectiveDue, '2026-11-24');
  assert.equal(entry.before.intervalDays, 8);
  assert.equal(entry.fieldsToAdd.mf_ideal_due, '2026-11-24');
  assert.equal(entry.fieldsToAdd.mf_not_before, null);
  assert.equal(entry.fieldsToAdd.mf_interval_days, 8);
  assert.equal(entry.fieldsToAdd.mf_scheduler_version, 1);
  assert.equal(entry.fieldsToAdd.mf_revision, 0);
  assert.equal(entry.fieldsToAdd.mf_last_event_id, null);
  assert.equal(entry.fieldsToAdd.mf_root_id, uuid(1));
});

test('review_count=0 with an existing interval never re-runs the initial formula', () => {
  const { raw } = note({ mfId: uuid(1), interval: 13, reviewCount: 0 });
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].fieldsToAdd.mf_interval_days, 13);
  assert.equal(plan.entries[0].after.intervalDays, 13);
  assert.notEqual(plan.entries[0].fieldsToAdd.mf_interval_days, 8);
});

test('an already migrated note needs no fields', () => {
  const { raw } = note({
    mfId: uuid(1),
    extra: {
      mf_ideal_due: '2026-11-24',
      mf_not_before: null,
      mf_interval_days: 8,
      mf_scheduler_version: 1,
      mf_revision: 0,
      mf_last_event_id: null,
      mf_root_id: uuid(1),
    },
  });
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'already-migrated');
  assert.deepEqual(plan.entries[0].fieldsToAdd, {});
  assert.equal(plan.summary.alreadyMigrated, 1);
});

test('blocked and conflicting notes never enter the executable set', () => {
  const { raw: missingPriority } = note({ path: 'Sources/B.md', basename: 'B', mfId: uuid(2) });
  delete missingPriority.priority;
  const { raw: inbox } = note({ path: 'Sources/C.md', basename: 'C', status: 'inbox', mfId: uuid(3) });
  const { raw: badDate } = note({ path: 'Sources/D.md', basename: 'D', nextReview: '31-04-2026', mfId: uuid(4) });
  const { raw: conflict } = note({
    path: 'Sources/E.md',
    basename: 'E',
    mfId: uuid(5),
    extra: { mf_ideal_due: '2026-11-25' },
  });

  const plan = previewMigration([missingPriority, inbox, badDate, conflict], CONTEXT);
  assert.deepEqual(plan.entries.map(entry => entry.status), ['blocked', 'blocked', 'blocked', 'conflict']);
  assert.equal(plan.executable, 0);
  assert.equal(plan.summary.blocked, 3);
  assert.equal(plan.summary.conflict, 1);
});

test('one broken note does not block the others', () => {
  const { raw: good } = note({ mfId: uuid(1) });
  const { raw: bad } = note({ path: 'Sources/B.md', basename: 'B', mfId: uuid(2), nextReview: 'not-a-date' });
  const plan = previewMigration([bad, good], CONTEXT);
  assert.equal(plan.entries[0].status, 'blocked');
  assert.equal(plan.entries[1].status, 'migratable');
  assert.equal(plan.summary.migratable, 1);
  assert.equal(plan.executable, 1);
});

test('temporary identities require an allocated UUID before migration', () => {
  const { raw } = note({ path: 'Sources/Temp.md', basename: 'Temp' });
  const withoutAllocator = previewMigration([raw], CONTEXT);
  assert.equal(withoutAllocator.entries[0].status, 'manual-review');
  assert.equal(withoutAllocator.entries[0].requiresUuid, true);
  assert.equal(withoutAllocator.entries[0].assignedUuid, null);
  assert.ok(withoutAllocator.entries[0].reasons.some(reason => reason.code === 'UUID_ALLOCATION_REQUIRED'));
  assert.equal(withoutAllocator.summary.requiresUuid, 1);
});

test('a five-level synthetic Source -> Extract chain keeps relations', () => {
  const source = note({ path: 'Sources/A.md', basename: 'A', mfId: uuid(1) });
  const topics = [source.raw];
  for (let level = 1; level <= 4; level += 1) {
    const parent = level === 1 ? 'A' : `L${level - 1}`;
    const child = note({
      path: `Extracts/L${level}.md`,
      basename: `L${level}`,
      type: 'extract',
      mfId: uuid(10 + level),
      parent: `[[${parent}]]`,
      source: '[[A]]',
      extra: { parent: `[[${parent}]]`, source: '[[A]]' },
    });
    topics.push(child.raw);
  }
  const plan = previewMigration(topics, CONTEXT);
  assert.equal(plan.summary.total, 5);
  assert.equal(plan.summary.migratable, 5);
  assert.equal(plan.entries[1].fieldsToAdd.mf_parent_id, uuid(1));
  assert.equal(plan.entries[4].fieldsToAdd.mf_parent_id, uuid(13));
  assert.equal(plan.entries[4].fieldsToAdd.mf_root_id, uuid(1));
});

test('preview is deterministic, frozen-input safe and carries no writes', () => {
  const { raw } = note({ mfId: uuid(1) });
  const frozen = JSON.parse(JSON.stringify(raw));
  Object.freeze(raw);
  const first = previewMigration([raw], CONTEXT, { snapshotId: 'snap-1' });
  const second = previewMigration([raw], CONTEXT, { snapshotId: 'snap-1' });
  assert.deepEqual(second, first);
  assert.equal(first.planId, second.planId);
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), frozen);
  assert.equal(first.writesPerformed, false);
});

// ---- snapshot evidence and existing not-before (review fixes 3, 5) --------

test('a preview without exact content cannot become executable', () => {
  const { raw } = note({ mfId: uuid(1) });
  delete raw.content;
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'manual-review');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'SNAPSHOT_CONTENT_MISSING'));
  assert.equal(plan.executable, 0);
});

test('an existing modern not-before is preserved on both sides', () => {
  const { raw } = note({ mfId: uuid(1), extra: { mf_not_before: '2026-11-30' } });
  const plan = previewMigration([raw], CONTEXT);
  const entry = plan.entries[0];
  assert.equal(entry.before.notBefore, '2026-11-30');
  assert.equal(entry.after.notBefore, '2026-11-30');
  assert.equal(entry.before.effectiveDue, '2026-11-30');
  assert.equal(entry.after.effectiveDue, '2026-11-30');
  assert.equal(entry.effectiveDuePreserved, true);
  assert.equal('mf_not_before' in entry.fieldsToAdd, false);
  assert.equal(entry.lossNotes.includes('NOT_BEFORE_NOT_RECOVERABLE'), false);
});

test('a fully modern note with not-before is already migrated', () => {
  const { raw } = note({
    mfId: uuid(1),
    extra: {
      mf_ideal_due: '2026-11-24',
      mf_not_before: '2026-11-30',
      mf_interval_days: 8,
      mf_scheduler_version: 1,
      mf_revision: 0,
      mf_last_event_id: null,
      mf_root_id: uuid(1),
    },
  });
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'already-migrated');
  assert.deepEqual(plan.entries[0].fieldsToAdd, {});
});

test('an illegal modern not-before blocks the note', () => {
  const { raw } = note({ mfId: uuid(1), extra: { mf_not_before: 'not-a-date' } });
  const plan = previewMigration([raw], CONTEXT);
  assert.equal(plan.entries[0].status, 'blocked');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'E_DATE_INVALID'));
});

test('a mixed batch keeps not-before and no-not-before entries separate', () => {
  const { raw: withNotBefore } = note({ mfId: uuid(1), extra: { mf_not_before: '2026-11-30' } });
  const { raw: without } = note({ mfId: uuid(2), path: 'Sources/B.md', basename: 'B' });
  const plan = previewMigration([withNotBefore, without], CONTEXT);
  assert.equal(plan.entries[0].before.effectiveDue, '2026-11-30');
  assert.equal(plan.entries[1].before.effectiveDue, '2026-11-24');
  assert.equal(plan.entries[1].fieldsToAdd.mf_not_before, null);
  assert.equal(plan.entries[1].lossNotes.includes('NOT_BEFORE_NOT_RECOVERABLE'), true);
});

// ---- add-only frontmatter protection (review fix 3) ----------------------

function withFrontmatterLine(raw, line) {
  const next = { ...raw };
  next.content = raw.content.replace('---\n', `---\n${line}\n`);
  return next;
}

test('a frontmatter field the metadata does not know is never overwritten', () => {
  const { raw } = note({ mfId: uuid(1) });
  const withField = withFrontmatterLine(raw, 'mf_ideal_due: 2026-12-01');
  const plan = previewMigration([withField], CONTEXT);
  assert.equal(plan.entries[0].status, 'conflict');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'E_FIELD_ALREADY_PRESENT'));
  assert.equal(plan.executable, 0);
});

test('an existing value equal to the plan is still a conflict when metadata is missing', () => {
  const { raw } = note({ mfId: uuid(1) });
  const withField = withFrontmatterLine(raw, 'mf_ideal_due: 2026-11-24');
  const plan = previewMigration([withField], CONTEXT);
  assert.equal(plan.entries[0].status, 'conflict');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'E_FIELD_ALREADY_PRESENT'));
});

test('an existing mf_revision in content blocks a metadata-only preview', () => {
  const { raw } = note({ mfId: uuid(1) });
  const withField = withFrontmatterLine(raw, 'mf_revision: 0');
  const plan = previewMigration([withField], CONTEXT);
  assert.equal(plan.entries[0].status, 'conflict');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'E_FIELD_ALREADY_PRESENT'));
});

test('duplicate frontmatter keys are refused', () => {
  const { raw } = note({ mfId: uuid(1) });
  const duplicate = {
    ...raw,
    content: raw.content.replace('---\n', '---\nmf_ideal_due: 2026-12-01\nmf_ideal_due: 2026-12-02\n'),
  };
  const plan = previewMigration([duplicate], CONTEXT);
  assert.equal(plan.entries[0].status, 'blocked');
  assert.ok(plan.entries[0].reasons.some(reason => reason.code === 'E_FRONTMATTER_DUPLICATE_KEY'));
});

test('a rejected record leaves the original content untouched', () => {
  const { raw } = note({ mfId: uuid(1) });
  const before = withFrontmatterLine(raw, 'mf_ideal_due: 2026-12-01');
  const snapshot = before.content;
  previewMigration([before], CONTEXT);
  assert.equal(before.content, snapshot);
});
