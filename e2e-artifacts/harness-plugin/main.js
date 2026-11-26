'use strict';
const { Plugin } = require('obsidian');

module.exports = class E2EHarness extends Plugin {
  async onload() {
    const log = [];
    const out = m => log.push(new Date().toISOString() + ' ' + m);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const state = { ok: false, phases: {}, log };
    const write = async () => {
      try { await this.app.vault.adapter.write('e2e-harness-result.json', JSON.stringify(state, null, 2)); } catch (e) { /* ignore */ }
    };
    const clickCtas = async (rounds = 16) => {
      for (let i = 0; i < rounds; i += 1) {
        const buttons = [...document.querySelectorAll('.modal-container button, .modal button')];
        const cta = buttons.find(b => /确认|继续|激活|确定|允许|Activate|Continue|OK/i.test(b.textContent || ''))
          || buttons.find(b => b.classList.contains('mod-cta'));
        if (!cta) { await sleep(200); continue; }
        out('click: ' + String(cta.textContent || '').trim().slice(0, 16));
        cta.click();
        await sleep(400);
      }
    };
    const fmOf = path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return {};
      return (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    };
    const ledgerOf = async () => {
      try {
        const data = JSON.parse(await this.app.vault.adapter.read('.obsidian/plugins/memoflow/data.json'));
        return (data.mfUs1Ledger && (data.mfUs1Ledger.records || data.mfUs1Ledger)) || {};
      } catch (e) { return {}; }
    };
    const grade = async (memo) => {
      const before = fmOf('Sources/E2E-A.md');
      let result; let error = null;
      try { result = await memo.endSession(); } catch (e) { error = String((e && e.message) || e); }
      await sleep(800);
      await clickCtas(6);
      await sleep(600);
      const after = fmOf('Sources/E2E-A.md');
      return {
        result: result === undefined ? null : result,
        error,
        before: { revision: before.mf_revision, notBefore: before.mf_not_before, idealDue: before.mf_ideal_due, lastEvent: before.mf_last_event_id },
        after: { revision: after.mf_revision, notBefore: after.mf_not_before, idealDue: after.mf_ideal_due, lastEvent: after.mf_last_event_id },
      };
    };
    setTimeout(async () => {
      try {
        const memo = this.app.plugins.plugins['memoflow'];
        if (!memo) { state.reason = 'memoflow not loaded'; await write(); return; }
        state.version = memo.manifest && memo.manifest.version;
        const path = 'Sources/E2E-A.md';
        if (!(await this.app.vault.adapter.exists(path))) {
          await this.app.vault.create(path, '---\ntype: source\nstatus: active\npriority: 50\ninterval: 8\na_factor: 1.5\nreview_count: 1\nlast_reviewed: 2026-10-01\nnext_review: 2026-11-20\ndate_added: 2026-10-01\nmf_id: 00000000-0000-4000-8000-0000000000a1\nmf_revision: 0\nmf_scheduler_version: 1\nmf_ideal_due: 2026-11-20\nmf_not_before: null\nmf_interval_days: 8\nmf_last_event_id: null\n---\n\n# E2E A\n\nharness seeded\n');
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        await this.app.workspace.getLeaf(true).openFile(file);
        for (let i = 0; i < 20; i += 1) {
          if (fmOf(path).type === 'source' && fmOf(path).mf_id) break;
          await sleep(250);
        }
        state.fmDetected = { type: fmOf(path).type, mf_id: fmOf(path).mf_id, mf_revision: fmOf(path).mf_revision };
        state.modeBefore = memo.settings && memo.settings.mf_us1_mode;

        this.app.commands.executeCommandById('memoflow:e2e-activate-unified');
        await sleep(700);
        await clickCtas(16);
        await sleep(1500);
        state.phases.activation = memo.mfUs1ActivationDiagnostics ? memo.mfUs1ActivationDiagnostics() : null;
        state.modeAfterActivation = memo.settings && memo.settings.mf_us1_mode;
        await write();

        state.phases.grade = await grade(memo);
        state.ledgerAfterGrade = await ledgerOf();
        state.ledgerCountAfterGrade = Object.keys(state.ledgerAfterGrade).length;
        await write();

        this.app.commands.executeCommandById('memoflow:e2e-revoke-unified');
        await sleep(1500);
        await clickCtas(8);
        await sleep(800);
        state.phases.revoked = memo.mfUs1ActivationDiagnostics ? memo.mfUs1ActivationDiagnostics() : null;
        state.ledgerAfterRevoke = await ledgerOf();
        state.ledgerCountAfterRevoke = Object.keys(state.ledgerAfterRevoke).length;
        await write();

        state.phases.gradeAfterRevoke = await grade(memo);
        state.ledgerAfterRejectedWrite = await ledgerOf();
        state.ledgerCountAfterRejectedWrite = Object.keys(state.ledgerAfterRejectedWrite).length;
        const denied = state.phases.gradeAfterRevoke;
        state.rejectedWriteNoChange = denied.after.revision === denied.before.revision
          && state.ledgerCountAfterRejectedWrite === state.ledgerCountAfterRevoke;
        state.ok = Boolean(state.phases.activation && state.phases.activation.authorized)
          && state.modeAfterActivation === 'unified'
          && state.ledgerCountAfterGrade > 0
          && Boolean(state.phases.revoked && state.phases.revoked.authorized === false)
          && state.rejectedWriteNoChange;
        await write();
        out('done ok=' + state.ok);
        this.app.plugins.disablePlugin('e2e-harness');
      } catch (error) {
        state.error = String((error && error.stack) || error);
        await write();
        try { this.app.plugins.disablePlugin('e2e-harness'); } catch (e) { /* ignore */ }
      }
    }, 2500);
  }
};
