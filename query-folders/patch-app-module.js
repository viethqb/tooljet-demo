#!/usr/bin/env node
'use strict';

/**
 * Patches the compiled EE app module.js to import and register QueryFoldersModule.
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
if (content.includes('query-folders/module')) {
  console.log('[Patch] module.js already patched, skipping');
  process.exit(0);
}

// 1. Add require statement for QueryFoldersModule
// Find the last require statement (before the class definition)
// We'll add our require right before "class AppModule" or "let AppModule"
const classPattern = /((?:class|let|var)\s+AppModule)/;
const classMatch = content.match(classPattern);

if (!classMatch) {
  console.error('[Patch] ERROR: Could not find AppModule class in module.js');
  process.exit(1);
}

const requireLine = 'const query_folders_module_1 = require("../query-folders/module");\n';
content = content.replace(classPattern, requireLine + '$1');

// 2. Add QueryFoldersModule.register(configs) to the baseImports array
// Strategy: find the last "register(configs)" or ".register(configs)," line before "];"
// and add our line after it

// Find "const baseImports = [" ... "];" block
// We look for the pattern of the last module registration in baseImports
// Using a robust approach: find "const conditionalImports" and insert before it

const conditionalPattern = /(const\s+conditionalImports\s*=)/;
const conditionalMatch = content.match(conditionalPattern);

if (conditionalMatch) {
  // Insert our module registration before conditionalImports
  // The baseImports array ends with "];" right before conditionalImports
  // We need to add our entry before the "];"
  const insertBefore = conditionalMatch.index;

  // Find the "];" that closes baseImports, searching backwards from conditionalImports
  const beforeConditional = content.substring(0, insertBefore);
  const lastCloseBracket = beforeConditional.lastIndexOf('];');

  if (lastCloseBracket === -1) {
    console.error('[Patch] ERROR: Could not find baseImports closing bracket');
    process.exit(1);
  }

  // Find the last comma before "];" to add after it
  const registerLine = '            await query_folders_module_1.QueryFoldersModule.register(configs),\n        ';
  content = content.substring(0, lastCloseBracket) + registerLine + content.substring(lastCloseBracket);
} else {
  // Fallback: try to find the baseImports array end differently
  // Look for pattern like ".register(configs),\n        ];"
  const arrayEndPattern = /(\.register\(configs\),?\s*\n\s*\];)/g;
  let lastMatch = null;
  let match;
  while ((match = arrayEndPattern.exec(content)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const insertPos = lastMatch.index + lastMatch[0].indexOf('];');
    const registerLine = '            await query_folders_module_1.QueryFoldersModule.register(configs),\n        ';
    content = content.substring(0, insertPos) + registerLine + content.substring(insertPos);
  } else {
    console.error('[Patch] ERROR: Could not find insertion point for module registration');
    process.exit(1);
  }
}

fs.writeFileSync(MODULE_FILE, content, 'utf8');
console.log('[Patch] Successfully patched module.js with QueryFoldersModule');
