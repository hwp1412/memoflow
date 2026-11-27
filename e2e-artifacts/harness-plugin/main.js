'use strict';
const { Plugin } = require('obsidian');
module.exports = class E2EHarness extends Plugin {
  async onload() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fs = this.app.vault.adapter; const out = {};
    const save = async n => { try { await fs.write(n, JSON.stringify(out, null, 2)); } catch (e) {} };
    const drive = async ms => { const st = Date.now(); while (Date.now() - st < ms) { const sg = document.querySelector('.suggestion-item'); if (sg) { sg.click(); await sleep(250); continue; } const m = document.querySelector('.modal-container'); if (m) { const b = [...m.querySelectorAll('button')]; const c = b.find(x => /OK|确认|继续|确定/i.test(x.textContent || '')) || b.find(x => x.classList.contains('mod-cta')); if (c) { c.click(); await sleep(300); continue; } } await sleep(120); } };
    const run = async (fn, ms) => { let v, e = null; const p = Promise.resolve().then(fn).then(x => { v = x; }, er => { e = String(er && er.message); }); await sleep(500); await drive(ms); await p; await sleep(800); return { value: v === undefined ? null : v, error: e }; };
    const fmOf = p => { const f = this.app.vault.getAbstractFileByPath(p); return f ? ((this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}) : {}; };
    setTimeout(async () => {
      try {
        const memo = this.app.plugins.plugins['memoflow'];
        out.act = await run(() => memo.mfUs1E2EActivateUnified(), 14000);
        out.auth = (memo.mfUs1ActivationDiagnostics() || {}).authorized;
        const SRC = 'Sources/Incremental Reading/Sources/N1.md';
        const EX = 'Sources/Incremental Reading/Extracts/N1-E.md';
        out.createSource = await memo._mfUs1CreateTopicFromHost({
          requestId: 'e2e-create-source-1', kind: 'source', priority: 55, path: SRC,
          content: '---\ntype: source\nstatus: active\npriority: 55\n---\n\n# N1\n', dateFormat: 'DD-MM-YYYY',
        });
        const sFm = fmOf(SRC);
        out.sourceFm = { mf_id: sFm.mf_id, mf_root_id: sFm.mf_root_id, mf_revision: sFm.mf_revision, type: sFm.type, status: sFm.status };
        const sFile = this.app.vault.getAbstractFileByPath(SRC);
        out.createExtract = await memo._mfUs1CreateTopicFromHost({
          requestId: 'e2e-create-extract-1', kind: 'extract', priority: 50, path: EX, parentFile: sFile,
          content: '---\ntype: extract\nstatus: active\npriority: 50\nsource: "[[N1]]"\n---\n\n# E\n', dateFormat: 'DD-MM-YYYY',
        });
        const eFm = fmOf(EX);
        out.extractFm = { mf_id: eFm.mf_id, mf_parent_id: eFm.mf_parent_id, mf_root_id: eFm.mf_root_id, type: eFm.type };
        // Card isolation: card must not enter MF-US-1 (no mf_*, not counted as topic)
        const CARD = 'Sources/Incremental Reading/Cards/C1.md';
        if (!(await fs.exists(CARD))) await this.app.vault.create(CARD, '---\ntype: card\nstatus: active\npriority: 40\n---\n\nQ:: a ::A:: b\n');
        await sleep(600);
        out.cardFm = fmOf(CARD);
        out.diagAfter = memo.mfUs1ActivationDiagnostics();
        out.ledger = (() => { try { const d = JSON.parse('' + ''); return 0; } catch (e) { return null; } })();
        await save('e2e-create.json');
        this.app.plugins.disablePlugin('e2e-harness');
      } catch (e) { out.error = String((e && e.stack) || e); await save('e2e-create.json'); try { this.app.plugins.disablePlugin('e2e-harness'); } catch (er) {} }
    }, 2500);
  }
};
