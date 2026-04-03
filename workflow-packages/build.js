#!/usr/bin/env node
/**
 * Build npm packages into an esbuild bundle for ToolJet workflows.
 * Runs during Docker build (RUN node build.js) — requires internet at build time.
 *
 * Uses browser polyfills for Node builtins so the bundle runs in isolated-vm
 * without needing real Node.js modules.
 *
 * Output: /app/workflow-packages/bundle.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ===================== CONFIGURE PACKAGES HERE =====================
const PACKAGES = {
  'exceljs': '^4.4.0',
  // 'papaparse': '^5.4.1',
  // 'lodash': '^4.17.21',
  // 'dayjs': '^1.11.10',
  // 'uuid': '^9.0.0',
  // 'json2csv': '^5.0.7',
  // 'pdf-lib': '^1.17.1',
};
// ===================================================================

// Browser polyfills for Node builtins (needed for isolated-vm)
const POLYFILLS = {
  'esbuild': '^0.24.0',
  'crypto-browserify': '^3.12.1',
  'stream-browserify': '^3.0.0',
  'buffer': '^6.0.3',
  'process': '^0.11.10',
  'events': '^3.3.0',
  'util': '^0.12.5',
  'path-browserify': '^1.0.1',
  'string_decoder': '^1.3.0',
  'readable-stream': '^4.5.2',
};

const OUTPUT_DIR = '/app/workflow-packages';
const TMP = '/tmp/wf-pkg-build';

console.log('[WorkflowPackages] Building:', JSON.stringify(PACKAGES));

// Clean
if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 1. Install target packages + polyfills + esbuild
fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({
  name: 'workflow-bundle', version: '1.0.0', private: true,
  dependencies: { ...PACKAGES, ...POLYFILLS },
}, null, 2));

console.log('[WorkflowPackages] Installing packages...');
execSync('npm install --ignore-scripts --no-audit --no-fund', {
  cwd: TMP, stdio: 'inherit', timeout: 120000,
  env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', npm_config_ignore_scripts: 'true' },
});

// 2. Build with esbuild using browser polyfills
console.log('[WorkflowPackages] Bundling with esbuild...');
const esbuild = require(path.join(TMP, 'node_modules', 'esbuild'));

// Entry: export only user packages (not polyfills)
const entryContent = Object.keys(PACKAGES)
  .map(pkg => `exports[${JSON.stringify(pkg)}] = require(${JSON.stringify(pkg)});`)
  .join('\n');
fs.writeFileSync(path.join(TMP, 'entry.js'), entryContent);

const result = esbuild.buildSync({
  entryPoints: [path.join(TMP, 'entry.js')],
  bundle: true,
  platform: 'browser',       // Use browser polyfills for Node builtins
  format: 'iife',
  globalName: 'WorkflowPackages',
  target: 'es2020',
  minify: true,
  treeShaking: true,
  write: false,
  mainFields: ['browser', 'module', 'main'],
  alias: {
    'crypto': path.join(TMP, 'node_modules/crypto-browserify'),
    'stream': path.join(TMP, 'node_modules/stream-browserify'),
    'buffer': path.join(TMP, 'node_modules/buffer'),
    'process': path.join(TMP, 'node_modules/process/browser.js'),
    'path': path.join(TMP, 'node_modules/path-browserify'),
    'string_decoder': path.join(TMP, 'node_modules/string_decoder'),
  },
  inject: [],
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
});

const rawBundle = result.outputFiles[0].text;

// Prepend minimal globals shim for isolated-vm
const shim = [
  'if(typeof process==="undefined"){var process={env:{NODE_ENV:"production"},versions:{node:"22.0.0"},version:"v22.0.0",platform:"linux",nextTick:function(f){f()},cwd:function(){return"/"},browser:true};}',
  'if(typeof setTimeout==="undefined"){var setTimeout=function(f){f();return 0};var clearTimeout=function(){};var setInterval=function(){return 0};var clearInterval=function(){};var setImmediate=function(f){f();return 0};}',
].join('\n') + '\n';

const bundleText = shim + rawBundle;
fs.writeFileSync(path.join(OUTPUT_DIR, 'bundle.js'), bundleText);
fs.writeFileSync(path.join(OUTPUT_DIR, 'dependencies.json'), JSON.stringify(PACKAGES));

// Cleanup
fs.rmSync(TMP, { recursive: true });
console.log('[WorkflowPackages] Done! Bundle:', (bundleText.length / 1024).toFixed(1), 'KB');
