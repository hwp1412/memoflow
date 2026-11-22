'use strict';

// Build-time localizer for the upstream Toolkit source. The upstream logic is
// untouched; only exact user-facing string literals are swapped for Chinese.
const BASE_STRINGS = require('./base-zh.json');

function encodeLiteral(value, quote) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `\\${quote}`);
}

function literalVariants(value) {
  return [
    `'${encodeLiteral(value, "'")}'`,
    `"${encodeLiteral(value, '"')}"`,
    `\`${encodeLiteral(value, '`')}\``,
  ];
}

function localizeBaseSource(source) {
  let output = String(source);
  for (const [english, chinese] of Object.entries(BASE_STRINGS)) {
    if (!english || english === chinese) continue;
    const from = literalVariants(english);
    const to = literalVariants(chinese);
    for (let i = 0; i < from.length; i++) {
      if (output.includes(from[i])) output = output.split(from[i]).join(to[i]);
    }
  }
  // This one embeds an escaped newline inside a template expression; the
  // generic literal encoder would double-escape it.
  output = output.replace(
    /Setup needs attention:\\n- \$\{issues\.join\('\\n- '\)\}/g,
    "环境检查需要处理：\\n- ${issues.join('\\n- ')}",
  );
  return output;
}

module.exports = { BASE_STRINGS, localizeBaseSource };
