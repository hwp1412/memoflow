#!/usr/bin/env node
// MF-US-1 formal performance benchmark (SPEC A14).
//
// Measures selectDailyQueue alone (not a whole-script timing) for 100 / 1,000 /
// 10,000 topics, with a cold call and a warm series, and reports median, P95
// and max. Mercy preview/apply are measured separately and never mixed into the
// A14 queue threshold. Inputs are synthetic and seeded; determinism and input
// immutability are verified in the same run.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const schedulingPath = fileURLToPath(new URL('../src/scheduling/index.js', import.meta.url));
const {
  selectDailyQueue,
  previewMercy,
  applyMercyBatch,
  addCalendarDays,
} = require(schedulingPath);

const SEED = 20260105;
const TODAY = '2026-01-05';
const WARM_RUNS = 25;
const QUEUE_TARGET_MS = 500;

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function buildTopics(size) {
  const topics = [];
  for (let index = 0; index < size; index += 1) {
    const type = index % 3 === 0 ? 'source' : 'extract';
    topics.push({
      type,
      status: index % 17 === 0 ? 'done' : 'active',
      priority: ((index * 37) % 100) + 1,
      mf_id: uuid(index + 1),
      mf_ideal_due: addCalendarDays(TODAY, ((index * 13) % 61) - 30),
      mf_not_before: index % 23 === 0 ? addCalendarDays(TODAY, -1) : null,
      mf_interval_days: 1 + ((index * 7) % 60),
      a_factor: 1.1 + (((index * 11) % 190) / 100),
      review_count: index % 5,
      mf_revision: index % 3,
      mf_scheduler_version: 1,
      last_reviewed: null,
      estimated_minutes: index % 7 === 0 ? 10 : 5,
    });
  }
  return topics;
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function stats(samples) {
  const sorted = samples.slice().sort((left, right) => left - right);
  return {
    runs: samples.length,
    medianMs: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    meanMs: Number((samples.reduce((total, value) => total + value, 0) / samples.length).toFixed(3)),
  };
}

function hashSelected(result) {
  const ids = result.selected.map(entry => entry.stableId).join(',');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

function measureQueue(size) {
  const topics = buildTopics(size);
  const frozenSnapshot = JSON.stringify(topics);

  const coldStart = performance.now();
  const coldResult = selectDailyQueue(topics, undefined, TODAY);
  const coldMs = performance.now() - coldStart;

  const samples = [];
  let lastResult = coldResult;
  for (let run = 0; run < WARM_RUNS; run += 1) {
    const start = performance.now();
    lastResult = selectDailyQueue(topics, undefined, TODAY);
    samples.push(performance.now() - start);
  }

  const unchanged = JSON.stringify(topics) === frozenSnapshot;
  const deterministic = hashSelected(coldResult) === hashSelected(lastResult);

  return {
    size,
    coldMs: Number(coldMs.toFixed(3)),
    warm: stats(samples),
    selected: coldResult.selected.length,
    candidates: coldResult.budget.candidateCount,
    usedMinutes: coldResult.budget.usedMinutes,
    budgetMinutes: coldResult.budget.budgetMinutes,
    invalid: coldResult.invalid.length,
    unchangedInput: unchanged,
    deterministic,
    hash: hashSelected(coldResult),
  };
}

function measureMercy(size) {
  const topics = buildTopics(size)
    .filter(topic => topic.status === 'active')
    .map(topic => ({ ...topic, mf_ideal_due: addCalendarDays(TODAY, -10), mf_not_before: null }));
  const config = { windowDays: 7, batchId: 'bench-mercy' };

  const previewStart = performance.now();
  const plan = previewMercy(topics, config, TODAY);
  const previewMs = performance.now() - previewStart;

  const applyStart = performance.now();
  const applied = applyMercyBatch(plan, topics, TODAY);
  const applyMs = performance.now() - applyStart;

  return {
    size: topics.length,
    previewMs: Number(previewMs.toFixed(3)),
    applyMs: Number(applyMs.toFixed(3)),
    assigned: plan.summary.assignedCount,
    applied: applied.summary.appliedCount,
  };
}

const sizes = [100, 1000, 10000];
const queueResults = sizes.map(measureQueue);
const mercyResult = measureMercy(10000);
const target = queueResults.find(result => result.size === 10000);

const report = {
  algorithmVersion: 1,
  measuredAt: new Date().toISOString(),
  seed: SEED,
  warmRuns: WARM_RUNS,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    execArgv: process.execArgv,
  },
  input: {
    distribution: '40% Source / 60% Extract, Priority 1-100, due -30..+30 days, mixed 5/10 minute costs',
    budgetMinutes: 30,
  },
  queue: queueResults,
  mercy: mercyResult,
  a14: {
    targetMs: QUEUE_TARGET_MS,
    measured10kMedianMs: target.warm.medianMs,
    pass: target.warm.medianMs < QUEUE_TARGET_MS,
    note: 'judged on this machine; a non-reference desktop must be disclosed as such',
  },
};

console.log('=== MF-US-1 queue benchmark (selectDailyQueue only) ===');
console.log(`node ${report.environment.node} | ${report.environment.platform}/${report.environment.arch} | ${report.environment.cpuModel} | ${report.environment.cpuCount} cores`);
console.log(`seed ${SEED}, warm runs ${WARM_RUNS}, budget 30 min, mixed Source/Extract`);
for (const result of queueResults) {
  console.log(
    `size ${String(result.size).padStart(5)}: cold ${result.coldMs.toFixed(2)}ms | median ${result.warm.medianMs.toFixed(2)}ms | p95 ${result.warm.p95Ms.toFixed(2)}ms | max ${result.warm.maxMs.toFixed(2)}ms | selected ${result.selected}/${result.candidates} | unchanged ${result.unchangedInput} | deterministic ${result.deterministic}`
  );
}
console.log(`A14 target 10k median < ${QUEUE_TARGET_MS}ms: ${report.a14.pass ? 'PASS' : 'FAIL'} (${target.warm.medianMs.toFixed(2)}ms)`);
console.log(`mercy (separate, not part of A14): preview 10k ${mercyResult.previewMs.toFixed(2)}ms | apply ${mercyResult.applyMs.toFixed(2)}ms | applied ${mercyResult.applied}`);
console.log('---JSON---');
console.log(JSON.stringify(report, null, 2));
