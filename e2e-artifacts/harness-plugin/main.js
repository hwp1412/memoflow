'use strict';
const { Plugin } = require('obsidian');
module.exports = class E2EHarness extends Plugin {
  async onload() {
    const log = []; const out = m => log.push(new Date().toISOString() + ' ' + m);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fs = this.app.vault.adapter;
    const state = { log };
    const save = async name => { try { await fs.write(name, JSON.stringify(state, null, 2)); } catch (e) {} };
    const noticesShown = () => [...document.querySelectorAll('.notice')].map(n => (n.textContent || '').trim()).filter(Boolean);
    const fmOf = p => { const f = this.app.vault.getAbstractFileByPath(p); return f ? ((this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}) : {}; };
    const seed = async (path, fields) => {
      if (await fs.exists(path)) return;
      await this.app.vault.create(path, '---\n' + Object.entries(fields).map(([k, v]) => `${k}: ${v === null ? 'null' : v}`).join('\n') + '\n---\n\n# seeded\n');
    };
    setTimeout(async () => {
      try {
        const memo = this.app.plugins.plugins['memoflow'];
        if (!memo) { state.reason = 'memoflow not loaded'; await save('e2e-diag.json'); return; }
        await seed('Sources/S.md', { type: 'source', status: 'active', priority: 60, interval: 10, a_factor: 1.5, review_count: 1, next_review: '2026-11-20', last_reviewed: '2026-10-01', date_added: '2026-10-01', mf_id: '00000000-0000-4000-8000-0000000000b1', mf_revision: 0, mf_scheduler_version: 1, mf_ideal_due: '2026-11-20', mf_not_before: null, mf_interval_days: 10, mf_last_event_id: null });
        await seed('Extracts/E1.md', { type: 'extract', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1, next_review: '2026-11-10', last_reviewed: '2026-10-01', date_added: '2026-10-01', source: '[[S]]', mf_id: '00000000-0000-4000-8000-0000000000b2', mf_revision: 0, mf_scheduler_version: 1, mf_ideal_due: '2026-11-10', mf_not_before: null, mf_interval_days: 8, mf_last_event_id: null, mf_parent_id: '00000000-0000-4000-8000-0000000000b1', mf_root_id: '00000000-0000-4000-8000-0000000000b1' });
        await seed('Extracts/E2.md', { type: 'extract', status: 'active', priority: 50, interval: 8, a_factor: 1.5, review_count: 1, next_review: '2026-11-12', last_reviewed: '2026-10-01', date_added: '2026-10-01', source: '[[E1]]', mf_id: '00000000-0000-4000-8000-0000000000b3', mf_revision: 0, mf_scheduler_version: 1, mf_ideal_due: '2026-11-12', mf_not_before: null, mf_interval_days: 8, mf_last_event_id: null, mf_parent_id: '00000000-0000-4000-8000-0000000000b2', mf_root_id: '00000000-0000-4000-8000-0000000000b1' });
        const s = this.app.vault.getAbstractFileByPath('Sources/S.md');
        await this.app.workspace.getLeaf(true).openFile(s);
        await sleep(2500);
        memo._mfUs1RefreshRows();
        state.before = {
          active: (this.app.workspace.getActiveFile() || {}).path || null,
          rows: memo.getIRRows().length,
          mode: memo.settings && memo.settings.mf_us1_mode,
          diag: memo.mfUs1ActivationDiagnostics ? memo.mfUs1ActivationDiagnostics() : null,
        };
        // activate first
        this.app.commands.executeCommandById('memoflow:e2e-activate-unified');
        const seen = [];
        for (let i = 0; i < 60; i += 1) {
          for (const text of noticesShown()) if (!seen.includes(text)) seen.push(text);
          const btn = document.querySelector('.modal-container .mod-cta');
          if (btn) btn.click();
          const sug = document.querySelector('.suggestion-item');
          if (sug) sug.click();
          await sleep(200);
        }
        state.activationNotices = seen.slice();
        state.afterActivation = memo.mfUs1ActivationDiagnostics ? memo.mfUs1ActivationDiagnostics() : null;
        await save('e2e-diag.json');
        // boost with notice capture
        const seen2 = [];
        const boostPromise = memo.boost();
        let resolved = 'pending'; let value = null;
        boostPromise.then(v => { resolved = 'ok'; value = v; }, e => { resolved = 'error'; value = String((e && e.message) || e); });
        for (let i = 0; i < 50; i += 1) {
          for (const text of noticesShown()) if (!seen2.includes(text)) seen2.push(text);
          const btn = document.querySelector('.modal-container .mod-cta');
          const sug = document.querySelector('.suggestion-item');
          const modalCount = document.querySelectorAll('.modal-container').length;
          if (modalCount) {
            if (sug) sug.click(); else if (btn) btn.click();
          }
          await sleep(200);
          if (resolved !== 'pending') break;
        }
        state.boostNotices = seen2.slice();
        state.boostResolved = resolved;
        state.boostValue = value === null || typeof value === 'object' ? value : String(value);
        state.after = {
          priorities: { S: fmOf('Sources/S.md').priority, E1: fmOf('Extracts/E1.md').priority, E2: fmOf('Extracts/E2.md').priority },
          rows: memo.getIRRows().length,
          active: (this.app.workspace.getActiveFile() || {}).path || null,
        };
        try {
          const data = JSON.parse(await fs.read('.obsidian/plugins/memoflow/data.json'));
          state.batches = Object.keys(data.mfUs1Batches || {}).length;
          state.ledger = Object.keys((data.mfUs1Ledger && (data.mfUs1Ledger.records || data.mfUs1Ledger)) || {}).length;
        } catch (e) {}
        await save('e2e-diag.json');
        this.app.plugins.disablePlugin('e2e-harness');
      } catch (error) {
        state.error = String((error && error.stack) || error);
        await save('e2e-diag.json');
        try { this.app.plugins.disablePlugin('e2e-harness'); } catch (e) {}
      }
    }, 2500);
  }
};
