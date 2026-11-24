'use strict';

// Chinese command palette names. Command IDs stay identical so existing
// hotkeys and scripts keep working.
const COMMAND_NAMES = {
  'build-session-queue': '构建今日学习队列',
  'next-element': '下一项',
  'end-session': '评阅当前阅读项',
  'extract-selection': '从选中内容摘录',
  'memoflow-refine-extract': '原位精简当前摘录',
  'memoflow-refine-history': '查看精简历史',
  'memoflow-restore-refine': '恢复上次精简',
  'flashcard-clipboard': '从剪贴板制卡',
  'capture-more': '采集或新建…',
  'current-actions': '当前阅读项操作…',
  'open-toolkit-view': '打开 MemoFlow 视图…',
  'advanced-tools': '高级工具…',
};

const MENU_LABELS = {
  captureTitle: '采集或新建',
  capture: [
    '新来源',
    '导入剪藏（当前笔记）',
    '从剪贴板摘录（PDF 感知）',
    '为图片命名制卡',
    '从剪贴板提取图片',
    '图片遮挡制卡',
  ],
  currentTitle: '当前阅读项操作',
  current: [
    '完成',
    '重置',
    '移出队列',
    '延后',
    '手动排期',
    '设置优先级',
    '提升优先级',
    '打开父项',
    '打开 PDF',
    '切换阅读点',
    '跳转阅读点',
    '添加时间线检查点',
  ],
  toolkitTitle: '打开 MemoFlow 视图',
  toolkit: [
    'MemoFlow 总览',
    '统计与分析',
    '阅读队列侧栏',
    '知识树',
    '知识树侧栏',
    '使用指南',
  ],
  advancedTitle: '高级工具',
  advanced: [
    '子集复习',
    'Mercy（摊平逾期）',
    '推迟子树',
    '按 H2 拆分文章',
    '按章节拆分书籍',
    '新建分类',
    '移动当前项到…',
    '导出内联卡片到 SR',
    '迁移旧卡片到 SR',
    '性能诊断',
  ],
};

module.exports = { COMMAND_NAMES, MENU_LABELS };
