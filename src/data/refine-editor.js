'use strict';

const {
  RefineError,
  splitContent,
  requireCurrentExtractType,
  createRefineOperation,
} = require('./refine-history.js');

class RefineFlowError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'RefineFlowError';
    this.code = code;
    this.details = details;
  }
}

function lineOffsets(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetToPos(text, offset) {
  const safe = Math.max(0, Math.min(text.length, offset));
  const starts = lineOffsets(text);
  let line = starts.length - 1;
  while (line > 0 && starts[line] > safe) line--;
  return { line, ch: safe - starts[line] };
}

function posToOffset(editor, text, pos) {
  if (editor && typeof editor.posToOffset === 'function') return editor.posToOffset(pos);
  const starts = lineOffsets(text);
  const line = Math.max(0, Math.min(starts.length - 1, Number(pos.line) || 0));
  return starts[line] + Math.max(0, Number(pos.ch) || 0);
}

function lineRanges(text) {
  const starts = lineOffsets(text);
  return starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] - 1 : text.length,
    line: index,
  }));
}

function intersects(range, start, end) {
  return range.start < end && range.end > start;
}

function fencedRanges(text) {
  const lines = lineRanges(text);
  const ranges = [];
  let open = null;
  for (const line of lines) {
    const raw = text.slice(line.start, line.end).replace(/\r$/, '');
    const marker = raw.match(/^\s*(```+|~~~+)/);
    if (!marker) continue;
    if (!open) open = { ...line, marker: marker[1][0] };
    else if (marker[1][0] === open.marker) {
      ranges.push({ start: open.start, end: line.end });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function isTableDelimiter(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length >= 2 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableRanges(text) {
  const lines = lineRanges(text);
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = text.slice(lines[i].start, lines[i].end).replace(/\r$/, '');
    if (!isTableDelimiter(raw)) continue;
    let start = Math.max(0, i - 1);
    let end = i;
    while (end + 1 < lines.length) {
      const next = text.slice(lines[end + 1].start, lines[end + 1].end).replace(/\r$/, '');
      if (!next.trim() || !next.includes('|')) break;
      end++;
    }
    ranges.push({ start: lines[start].start, end: lines[end].end });
    i = end;
  }
  return ranges;
}

function blockMathRanges(text) {
  const lines = lineRanges(text);
  const ranges = [];
  let open = null;
  for (const line of lines) {
    const raw = text.slice(line.start, line.end).replace(/\r$/, '');
    if (!/^\s*\$\$\s*$/.test(raw)) continue;
    if (!open) open = { ...line };
    else {
      ranges.push({ start: open.start, end: line.end });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function protectedRanges(text) {
  const source = String(text || '');
  const patterns = [
    /<!--\s*SR[^>]*-->/gi,
    /<!--\s*ir-readpoint\s*-->/gi,
    /📍/g,
    /\{\{c\d+::[\s\S]*?\}\}/g,
    /==[^=\n]+==/g,
    /!\[\[[^\]]+\]\]/g,
  ];
  const ranges = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) pattern.lastIndex++;
    }
  }
  return ranges;
}

function protectedText(value) {
  const text = String(value || '');
  const patterns = [
    /<!--\s*SR(?::|\s)/i,
    /<!--\s*ir-readpoint/i,
    /📍/,
    /\{\{c\d+::/i,
    /==[^=\n]+==/,
    /!\[\[/,
  ];
  return patterns.some(pattern => pattern.test(text));
}

function replacementProtected(value) {
  const text = String(value || '');
  return protectedText(text)
    || /(^|\n)\s*(```+|~~~+)/.test(text)
    || /(^|\n)\s*\|.*\|\s*($|\n)/.test(text)
    || /\$\$/.test(text);
}

class RefineEditorController {
  constructor({
    app,
    store,
    settings = {},
    notice = () => {},
    promptPreview,
    promptRestore,
    getActiveView = null,
  } = {}) {
    if (!app) throw new RefineFlowError('APP_REQUIRED', 'app is required');
    if (!store) throw new RefineFlowError('STORE_REQUIRED', 'refine store is required');
    this.app = app;
    this.store = store;
    this.settings = settings;
    this.notice = notice;
    this.promptPreview = promptPreview;
    this.promptRestore = promptRestore;
    this.getActiveView = getActiveView;
    this._busy = false;
  }

  _view() {
    if (this.getActiveView) return this.getActiveView();
    return null;
  }

  _samePathLeaves(filePath) {
    const leaves = this.app.workspace?.getLeavesOfType?.('markdown') || [];
    return leaves.filter(leaf => leaf.view?.file?.path === filePath);
  }

  _assertSingleWindow(filePath) {
    const leaves = this._samePathLeaves(filePath);
    if (leaves.length > 1) {
      throw new RefineFlowError('MULTI_WINDOW', '同一笔记存在多个编辑窗口，已安全停止');
    }
  }

  _selectionOffsets(editor, text, split) {
    const selections = typeof editor.listSelections === 'function' ? editor.listSelections() : [];
    if (Array.isArray(selections) && selections.length > 1) {
      throw new RefineFlowError('MULTI_SELECTION', '只支持一个连续正文选区');
    }
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const selectedText = editor.getSelection();
    if (!selectedText || !selectedText.trim()) {
      throw new RefineFlowError('EMPTY_SELECTION', '请先选中连续正文');
    }
    const fromOffset = posToOffset(editor, text, from);
    const toOffset = posToOffset(editor, text, to);
    const start = fromOffset - split.bodyStart;
    const end = toOffset - split.bodyStart;
    if (start < 0 || end <= start || end > split.body.length) {
      throw new RefineFlowError('SELECTION_OUTSIDE_BODY', '选区必须完全位于正文，不能包含 Frontmatter');
    }
    const exact = split.body.slice(start, end);
    if (exact !== selectedText) {
      throw new RefineFlowError('SELECTION_MISMATCH', '选区文字与正文不一致');
    }
    return { start, end, from, to, selectedText };
  }

  async _snapshot(requireSelection = true) {
    const view = this._view();
    if (!view || !view.file || !view.editor) {
      throw new RefineFlowError('NO_ACTIVE_EDITOR', '请先打开一个 Markdown 摘录');
    }
    if (view.file.extension && view.file.extension !== 'md') {
      throw new RefineFlowError('NOT_MARKDOWN', '当前文件不是 Markdown');
    }
    this._assertSingleWindow(view.file.path);
    const text = view.editor.getValue();
    const disk = await this.app.vault.read(view.file);
    if (text !== disk) {
      throw new RefineFlowError('EDITOR_NOT_SAVED', '编辑器内容尚未保存到磁盘，请先保存并重新执行');
    }
    requireCurrentExtractType(text);
    const split = splitContent(text);
    const selection = requireSelection ? this._selectionOffsets(view.editor, text, split) : null;
    return {
      view,
      editor: view.editor,
      file: view.file,
      path: view.file.path,
      text,
      disk,
      split,
      prefix: split.prefix,
      body: split.body,
      bodyStart: split.bodyStart,
      selection,
    };
  }

  async _assertUnchanged(snapshot) {
    const view = snapshot.view;
    if (!view || !view.file || view.file.path !== snapshot.path) {
      throw new RefineFlowError('FILE_CHANGED', '当前文件已变化，请重新执行');
    }
    const activeFile = this.app.workspace?.getActiveFile?.();
    if (activeFile && activeFile.path !== snapshot.path) {
      throw new RefineFlowError('FILE_CHANGED', '当前文件已变化，请重新执行');
    }
    this._assertSingleWindow(snapshot.path);
    const text = view.editor.getValue();
    if (text !== snapshot.text) {
      throw new RefineFlowError('CONTENT_CHANGED', '编辑内容已变化，请重新执行');
    }
    const disk = await this.app.vault.read(view.file);
    if (disk !== snapshot.text) {
      throw new RefineFlowError('DISK_CHANGED', '磁盘内容已变化，请重新执行');
    }
    requireCurrentExtractType(text);
    const split = splitContent(text);
    if (split.bodyStart !== snapshot.bodyStart || split.body !== snapshot.body) {
      throw new RefineFlowError('CONTENT_CHANGED', '正文结构已变化，请重新执行');
    }
    if (snapshot.selection) {
      const current = split.body.slice(snapshot.selection.start, snapshot.selection.end);
      if (current !== snapshot.selection.selectedText) {
        throw new RefineFlowError('SELECTION_CHANGED', '选区内容已变化，请重新执行');
      }
    }
    return { text, disk, split };
  }

  _assertSafe(snapshot, replacement) {
    const body = snapshot.body;
    const start = snapshot.selection.start;
    const end = snapshot.selection.end;
    const selected = snapshot.selection.selectedText;
    if (protectedText(selected) || replacementProtected(replacement)) {
      throw new RefineFlowError('UNSAFE_MARKDOWN', '选区或替换内容包含受保护的 SR/卡片/阅读点/嵌入语法');
    }
    const ranges = [...fencedRanges(body), ...tableRanges(body), ...blockMathRanges(body), ...protectedRanges(body)];
    if (ranges.some(range => intersects(range, start, end))) {
      throw new RefineFlowError('UNSAFE_MARKDOWN', '选区跨越代码块、表格或块级公式，第一版拒绝');
    }
    // A replacement can create a table together with surrounding text even
    // when neither the selection nor the replacement alone looks like one.
    const replacementStart = start;
    const replacementEnd = start + String(replacement).length;
    const expectedBody = body.slice(0, start) + String(replacement) + body.slice(end);
    if (tableRanges(expectedBody).some(range => intersects(range, replacementStart, replacementEnd))) {
      throw new RefineFlowError('UNSAFE_MARKDOWN', '替换会新建或改变 Markdown 表格，第一版拒绝');
    }
    const inline = this.settings?.inline_cards || {};
    for (const key of ['qa_regex', 'cloze_regex']) {
      if (!inline[key]) continue;
      try {
        const regex = new RegExp(inline[key], 'm');
        if (regex.test(selected) || regex.test(replacement)) {
          throw new RefineFlowError('UNSAFE_MARKDOWN', '选区或替换内容命中 inline Card 语法');
        }
      } catch (error) {
        if (error instanceof RefineFlowError) throw error;
        throw new RefineFlowError('INVALID_INLINE_REGEX', 'inline Card/SR 正则配置无效，已安全拒绝');
      }
    }
    if (replacement === selected) {
      throw new RefineFlowError('NO_CHANGE', '替换文本与原文相同');
    }
  }

  async _conflict(operation) {
    if (!operation) return;
    try { await this.store.setStatus(operation.operationId, 'conflict'); } catch (error) { /* preserve prepared/applied */ }
  }

  async _failed(operation) {
    if (!operation) return;
    try { await this.store.setStatus(operation.operationId, 'failed'); } catch (error) { /* preserve */ }
  }

  async _saveAndVerify(snapshot, expectedFullContent) {
    if (typeof snapshot.view.save !== 'function') {
      throw new RefineFlowError('SAVE_UNAVAILABLE', '当前 Obsidian 编辑器没有可用的保存接口，已停止');
    }
    await snapshot.view.save();
    let disk = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      disk = await this.app.vault.read(snapshot.file);
      if (disk === expectedFullContent) return disk;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new RefineFlowError('DISK_MISMATCH', '保存后的磁盘内容与预期不一致，已停止');
  }

  async _diagnostic(operation, snapshot, expected) {
    let history = 'unknown';
    if (operation) {
      try { history = (await this.store.readState(operation.operationId)).status; }
      catch (error) { history = 'unknown'; }
    }
    let editor = 'unknown';
    let disk = 'unknown';
    try {
      editor = snapshot.editor.getValue() === expected ? 'matches' : 'differs';
    } catch (error) { editor = 'unknown'; }
    try {
      const actual = await this.app.vault.read(snapshot.file);
      if (actual === expected) disk = 'matches';
      else if (actual === snapshot.text) disk = 'unchanged';
      else disk = 'differs';
    } catch (error) { disk = 'unknown'; }
    return `历史状态=${history}；Editor=${editor}；磁盘=${disk}。`;
  }

  _notifyError(error, operation) {
    if (error.details?.diagnostic) {
      this.notice(`${error.message || error.code} ${error.details.diagnostic} 历史已保留，操作未完成。`, 10000);
      return;
    }
    if (error.details?.operationPersisted) {
      this.notice(`${error.message || error.code} 历史快照已写入，但状态初始化失败；正文未修改，历史已保留。`, 10000);
      return;
    }
    const suffix = operation
      ? ` 操作未完成，历史已保留（${operation.operationId}）。`
      : ' 操作未开始。';
    this.notice(`${error.message || error.code}${suffix}`, 9000);
  }

  async refineActive() {
    if (this._busy) {
      this.notice('已有精简操作正在进行，请稍候。', 5000);
      return null;
    }
    this._busy = true;
    let operation = null;
    try {
      if (!this.promptPreview) throw new RefineFlowError('PREVIEW_UNAVAILABLE', '缺少预览确认界面');
      const snapshot = await this._snapshot(true);
      const replacement = await this.promptPreview({
        path: snapshot.path,
        selectedText: snapshot.selection.selectedText,
        replacementText: snapshot.selection.selectedText,
      });
      if (replacement == null) return null;
      const replacementText = String(replacement);
      if (replacementText === snapshot.selection.selectedText) {
        this.notice('替换文本与原文相同，未创建历史。', 5000);
        return null;
      }
      this._assertSafe(snapshot, replacementText);
      await this._assertUnchanged(snapshot);

      const prepared = await this.store.prepareRefine({
        operationId: globalThis.crypto.randomUUID(),
        notePath: snapshot.path,
        fullContent: snapshot.text,
        selection: {
          start: snapshot.selection.start,
          end: snapshot.selection.end,
          selectedText: snapshot.selection.selectedText,
        },
        replacementText,
      });
      operation = prepared.operation;

      try {
        await this._assertUnchanged(snapshot);
      } catch (error) {
        await this._conflict(operation);
        throw error;
      }

      const expectedBody = snapshot.body.slice(0, snapshot.selection.start)
        + replacementText
        + snapshot.body.slice(snapshot.selection.end);
      const expected = snapshot.prefix + expectedBody;

      try {
        snapshot.editor.replaceRange(replacementText, snapshot.selection.from, snapshot.selection.to);
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        await this._failed(operation);
        throw new RefineFlowError('EDITOR_REPLACE_FAILED', '编辑器替换失败，正文/磁盘状态需检查。', { diagnostic });
      }
      if (snapshot.editor.getValue() !== expected) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        await this._conflict(operation);
        throw new RefineFlowError('EDITOR_CONTENT_MISMATCH', '编辑器内容与预期不一致，已停止。', { diagnostic });
      }

      try {
        await this.store.setStatus(operation.operationId, 'applied');
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        throw new RefineFlowError('STATUS_UPDATE_FAILED', '状态更新失败；正文修改已在 Editor 中发生，磁盘状态需检查。', { diagnostic });
      }

      try {
        const disk = await this._saveAndVerify(snapshot, expected);
        await this.store.markVerified(operation.operationId, disk);
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        if (error.code === 'DISK_MISMATCH') await this._conflict(operation);
        throw new RefineFlowError(error.code || 'SAVE_OR_VERIFY_FAILED', `${error.message || '保存或验证失败'}`, { diagnostic });
      }

      this.notice('原位精简已完成。', 5000);
      return operation;
    } catch (error) {
      this._notifyError(error, operation);
      return null;
    } finally {
      this._busy = false;
    }
  }

  async restoreActive() {
    if (this._busy) {
      this.notice('已有精简操作正在进行，请稍候。', 5000);
      return null;
    }
    this._busy = true;
    let operation = null;
    try {
      if (!this.promptRestore) throw new RefineFlowError('RESTORE_UI_UNAVAILABLE', '缺少恢复确认界面');
      const snapshot = await this._snapshot(false);
      const plan = await this.store.planRestore(snapshot.path, snapshot.text);
      const confirmed = await this.promptRestore({
        path: snapshot.path,
        currentBody: snapshot.body,
        restoredBody: plan.operation.after.body,
      });
      if (!confirmed) return null;

      await this._assertUnchanged(snapshot);
      await this.store.writeRestorePlan(plan);
      operation = plan.operation;

      try {
        await this._assertUnchanged(snapshot);
      } catch (error) {
        await this._conflict(operation);
        throw error;
      }

      const expected = snapshot.prefix + operation.after.body;
      const from = offsetToPos(snapshot.text, snapshot.bodyStart);
      const to = offsetToPos(snapshot.text, snapshot.text.length);
      try {
        snapshot.editor.replaceRange(operation.after.body, from, to);
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        await this._failed(operation);
        throw new RefineFlowError('EDITOR_REPLACE_FAILED', '恢复时编辑器替换失败，正文/磁盘状态需检查。', { diagnostic });
      }
      if (snapshot.editor.getValue() !== expected) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        await this._conflict(operation);
        throw new RefineFlowError('EDITOR_CONTENT_MISMATCH', '恢复后的编辑器内容与预期不一致，已停止。', { diagnostic });
      }

      try {
        await this.store.setStatus(operation.operationId, 'applied');
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        throw new RefineFlowError('STATUS_UPDATE_FAILED', '恢复正文已在 Editor 中修改，但状态更新失败；磁盘状态需检查。', { diagnostic });
      }

      try {
        const disk = await this._saveAndVerify(snapshot, expected);
        await this.store.markVerified(operation.operationId, disk);
        await this.store.markRestored(operation.operationId, disk);
      } catch (error) {
        const diagnostic = await this._diagnostic(operation, snapshot, expected);
        if (error.code === 'DISK_MISMATCH') await this._conflict(operation);
        throw new RefineFlowError(error.code || 'RESTORE_SAVE_OR_VERIFY_FAILED', error.message || '恢复保存或验证失败', { diagnostic });
      }

      this.notice('已恢复最近一次精简。', 5000);
      return operation;
    } catch (error) {
      this._notifyError(error, operation);
      return null;
    } finally {
      this._busy = false;
    }
  }
}

module.exports = {
  RefineEditorController,
  RefineFlowError,
  offsetToPos,
  posToOffset,
  protectedText,
  replacementProtected,
  protectedRanges,
};
