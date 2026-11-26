'use strict';

// Legacy-write guard for remaining direct writers (HOST-CLOSURE P0).
//
// Until every residual writer is either wired to the host or explicitly
// retired, Unified mode must not silently fall back to the legacy writer.
// Call sites ask this guard before touching Frontmatter; in Unified mode the
// write is refused and the user is told once per feature.

function modeOf(plugin) {
  if (!plugin || !plugin.settings) return 'legacy';
  return plugin.settings.mf_us1_mode || 'legacy';
}

function isUnifiedMode(plugin) {
  return modeOf(plugin) === 'unified';
}

function guardLegacySchedulingWrite(plugin, feature) {
  if (!isUnifiedMode(plugin)) return { blocked: false, first: false, message: null };
  if (!plugin.__mfUs1BlockedWrites) plugin.__mfUs1BlockedWrites = new Set();
  const first = !plugin.__mfUs1BlockedWrites.has(feature);
  plugin.__mfUs1BlockedWrites.add(feature);
  return {
    blocked: true,
    first,
    code: 'E_UNIFIED_LEGACY_WRITE_BLOCKED',
    message: `Unified 模式下暂不支持「${feature}」的旧写入路径；该操作未执行。`,
  };
}

module.exports = { modeOf, isUnifiedMode, guardLegacySchedulingWrite };
