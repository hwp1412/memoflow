'use strict';
const { Plugin } = require('obsidian');
module.exports = class E2EHarness extends Plugin {
  async onload() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fs = this.app.vault.adapter; const out = {};
    const save = async n => { try { await fs.write(n, JSON.stringify(out, null, 2)); } catch (e) {} };
    const drive = async ms => { const st = Date.now(); while (Date.now() - st < ms) { const sg = document.querySelector('.suggestion-item'); if (sg) { sg.click(); await sleep(250); continue; } const m = document.querySelector('.modal-container'); if (m) { const b = [...m.querySelectorAll('button')]; const c = b.find(x => /OK|确认|继续|确定/i.test(x.textContent || '')) || b.find(x => x.classList.contains('mod-cta')); if (c) { c.click(); await sleep(300); continue; } } await sleep(120); } };
    const run = async (fn, ms) => { let v, e = null; const p = Promise.resolve().then(fn).then(x => { v = x; }, er => { e = String(er && er.message); }); await sleep(600); await drive(ms); await p; await sleep(1000); await drive(1200); return { value: v === undefined ? null : v, error: e }; };
    const fmOf = p => { const f = this.app.vault.getAbstractFileByPath(p); return f ? ((this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}) : {}; };
    const dataOf = async () => { try { return JSON.parse(await fs.read('.obsidian/plugins/memoflow/data.json')); } catch (e) { return {}; } };
    setTimeout(async () => {
      try {
        const memo = this.app.plugins.plugins['memoflow'];
        if (!memo) { out.reason = 'no plugin'; await save('e2e-restart.json'); return; }
        // Phase B: restart recovery evidence
        const d = await dataOf();
        const ledger = (d.mfUs1Ledger && (d.mfUs1Ledger.records || d.mfUs1Ledger)) || {};
        out.restart = {
          mode: JSON.parse(JSON.stringify(memo.settings.mf_us1_mode)),
          ledgerCount: Object.keys(ledger).length,
          batchCount: Object.keys(d.mfUs1Batches || {}).length,
          recovery: memo.mfUs1Recovery,
          batchRecovery: memo.mfUs1BatchRecovery && memo.mfUs1BatchRecovery.summary,
          diag: memo.mfUs1ActivationDiagnostics(),
        };
        // Shadow: legacy writes + read-only observer
        const L1 = 'Sources/Incremental Reading/Extracts/L1.md';
        if (!(await fs.exists(L1))) await this.app.vault.create(L1, '---\ntype: extract\nstatus: active\npriority: 50\ninterval: 8\na_factor: 1.5\nreview_count: 1\nnext_review: 2026-11-11\nlast_reviewed: 2026-10-01\ndate_added: 2026-10-01\nsource: "[[S]]"\n---\n\n# L1\n');
        memo.settings.mf_us1_mode = 'shadow';
        if (typeof memo.saveSettings === 'function') await memo.saveSettings();
        memo._mfUs1HostInstance = null;
        const l1 = this.app.vault.getAbstractFileByPath(L1);
        await this.app.workspace.getLeaf(true).openFile(l1); await sleep(800);
        const before = fmOf(L1);
        const shadowRun = await run(() => memo.endSession(), 12000);
        const after = fmOf(L1);
        out.shadow = {
          run: shadowRun,
          before: { interval: before.interval, next: before.next_review, mf: before.mf_revision },
          after: { interval: after.interval, next: after.next_review, mf: after.mf_revision },
          shadowLast: memo.mfUs1ShadowLast || null,
          ledgerAfter: Object.keys((await dataOf()).mfUs1Ledger && ((await dataOf()).mfUs1Ledger.records || (await dataOf()).mfUs1Ledger) || {}).length,
        };
        await save('e2e-restart.json');
        this.app.plugins.disablePlugin('e2e-harness');
      } catch (e) { out.error = String((e && e.stack) || e); await save('e2e-restart.json'); try { this.app.plugins.disablePlugin('e2e-harness'); } catch (er) {} }
    }, 2500);
  }
};
