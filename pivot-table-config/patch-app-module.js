#!/usr/bin/env node
'use strict';

/**
 * Patches the compiled EE app module.js to import and register PivotTableConfigModule.
 * Runs at Docker build time.
 */

const fs = require('fs');
const path = require('path');

const MODULE_FILE = '/app/server/dist/src/modules/app/module.js';

if (!fs.existsSync(MODULE_FILE)) {
  console.error('[Patch] ERROR: module.js not found at', MODULE_FILE);
  process.exit(1);
}

let content = fs.readFileSync(MODULE_FILE, 'utf8');

// Check if already patched
if (content.includes('pivot-table-config/module')) {
  console.log('[Patch] module.js already patched with PivotTableConfigModule, skipping');
  process.exit(0);
}

// 1. Add require statement before AppModule class
const classPattern = /((?:class|let|var)\s+AppModule)/;
const classMatch = content.match(classPattern);

if (!classMatch) {
  console.error('[Patch] ERROR: Could not find AppModule class in module.js');
  process.exit(1);
}

const requireLine = 'const pivot_table_config_module_1 = require("../pivot-table-config/module");\n';
content = content.replace(classPattern, requireLine + '$1');

// 2. Add PivotTableConfigModule.register(configs) to the baseImports array
const conditionalPattern = /(const\s+conditionalImports\s*=)/;
const conditionalMatch = content.match(conditionalPattern);

if (conditionalMatch) {
  const insertBefore = conditionalMatch.index;
  const beforeConditional = content.substring(0, insertBefore);
  const lastCloseBracket = beforeConditional.lastIndexOf('];');

  if (lastCloseBracket === -1) {
    console.error('[Patch] ERROR: Could not find baseImports closing bracket');
    process.exit(1);
  }

  const registerLine = '            await pivot_table_config_module_1.PivotTableConfigModule.register(configs),\n        ';
  content = content.substring(0, lastCloseBracket) + registerLine + content.substring(lastCloseBracket);
} else {
  const arrayEndPattern = /(\.register\(configs\),?\s*\n\s*\];)/g;
  let lastMatch = null;
  let match;
  while ((match = arrayEndPattern.exec(content)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const insertPos = lastMatch.index + lastMatch[0].indexOf('];');
    const registerLine = '            await pivot_table_config_module_1.PivotTableConfigModule.register(configs),\n        ';
    content = content.substring(0, insertPos) + registerLine + content.substring(insertPos);
  } else {
    console.error('[Patch] ERROR: Could not find insertion point for module registration');
    process.exit(1);
  }
}

fs.writeFileSync(MODULE_FILE, content, 'utf8');
console.log('[Patch] Successfully patched module.js with PivotTableConfigModule');
