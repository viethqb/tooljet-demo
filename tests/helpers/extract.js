// Helpers to extract pure functions from production files so we can unit-test them
// without refactoring the production code structure.
//
// Strategy: read the source file, locate specific `function X(...) { ... }` blocks by
// brace-balancing, and `eval` them in a controlled closure that exposes what we need.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SERVICE_PATH = path.join(REPO, 'pivot-table-config', 'dist', 'ee', 'service.js');
const INJECT_PATH = path.join(REPO, 'pivot-table', 'inject.js');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

// Extract a top-level `function NAME(args) { body }` block by brace balancing.
// Also works for `var NAME = function (args) { body }`.
// Also works for class methods: `    NAME(args) {` at any indent.
// Returns the full source including the function keyword.
function extractFunctionSource(src, name) {
  // Try `function NAME(...) {`
  const re = new RegExp(`(?:^|\\n)\\s*function\\s+${name}\\s*\\(`);
  let match = re.exec(src);
  if (!match) {
    // Try `var/const/let NAME = function (...) {`
    const re2 = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*function\\s*\\(`);
    match = re2.exec(src);
  }
  if (!match) {
    // Try class method: `\n    NAME(args) {` (captures leading whitespace)
    const re3 = new RegExp(`\\n(\\s+)${name}\\s*\\([^)]*\\)\\s*{`);
    const m3 = re3.exec(src);
    if (m3) {
      // Synthesize signature-only starting position for consistency
      match = { index: m3.index + 1, 0: m3[0].slice(1) }; // skip leading \n
    }
  }
  if (!match) throw new Error('Function not found: ' + name);

  const startIdx = match.index + match[0].length - 1; // position of `(`
  // Find matching `{` after signature
  let i = startIdx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) throw new Error('No opening brace for ' + name);

  // Brace balance
  let depth = 0;
  let end = i;
  let prevMeaningful = '{'; // last non-whitespace char (seeds as '{' so / after it would be regex — but we start at '{')
  function isRegexStartContext(ch) {
    // `/` starts a regex when preceded by: ( , = ! & | ? : ; { [ return, or start of line
    return /[(,=!&|?:;{[\n]/.test(ch) || ch === '' || ch === ' ';
  }
  while (end < src.length) {
    const ch = src[end];
    if (ch === '{') { depth++; prevMeaningful = ch; end++; continue; }
    else if (ch === '}') { depth--; if (depth === 0) { end++; break; } prevMeaningful = ch; end++; continue; }
    // Skip strings
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      end++;
      while (end < src.length) {
        if (src[end] === '\\') { end += 2; continue; }
        if (src[end] === quote) break;
        end++;
      }
      prevMeaningful = quote; end++; continue;
    }
    // Skip /* */ comments
    else if (ch === '/' && src[end + 1] === '*') {
      end += 2;
      while (end < src.length - 1 && !(src[end] === '*' && src[end + 1] === '/')) end++;
      end += 2;
      continue;
    }
    // Skip // comments
    else if (ch === '/' && src[end + 1] === '/') {
      while (end < src.length && src[end] !== '\n') end++;
      continue;
    }
    // Skip regex literals when `/` is in an expression-start context
    else if (ch === '/' && isRegexStartContext(prevMeaningful)) {
      end++;
      while (end < src.length) {
        const c2 = src[end];
        if (c2 === '\\') { end += 2; continue; }
        if (c2 === '[') { // character class — skip until closing ]
          end++;
          while (end < src.length && src[end] !== ']') { if (src[end] === '\\') end++; end++; }
        }
        if (src[end] === '/') break;
        end++;
      }
      // Skip flags like gim
      end++;
      while (end < src.length && /[a-z]/.test(src[end])) end++;
      prevMeaningful = '/'; continue;
    }
    if (!/\s/.test(ch)) prevMeaningful = ch;
    end++;
  }

  // Walk backward from match.index to include signature
  let headerStart = match.index;
  while (headerStart < src.length && /\s/.test(src[headerStart])) headerStart++;
  return src.slice(headerStart, end);
}

// Build a sandbox that exposes selected functions from the service.js file.
// We construct a synthetic module body that evaluates just the helpers we need.
function loadBackendHelpers() {
  const src = readFile(SERVICE_PATH);

  // Functions to extract (top-level, self-contained enough)
  const names = [
    'escId',
    'buildAggSql',
    'parseExpressionSrv',
    'compileAstToSql',
    'normalizeServerConfig',
  ];
  // Class methods to extract as standalone functions (don't use `this`)
  const methods = ['_buildPivotSql', '_buildSubtotalSql', '_buildGrandTotalSql'];

  // Stubs for service-only references (HttpException, __decorate, etc.)
  const preamble = `
    const common_1 = {
      HttpException: class HttpException extends Error {
        constructor(msg, status) { super(msg); this.status = status; }
      },
      HttpStatus: { BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 },
      Injectable: function () { return function () {}; },
    };
    var __decorate = function () { return null; };
    var __metadata = function () { return null; };
    var AGG_CALL_NAMES_SRV = { SUM: 1, AVG: 1, COUNT: 1, MIN: 1, MAX: 1, COUNT_DISTINCT: 1 };
    var VALID_AGGREGATORS = ['count','sum','avg','min','max','distinct','median','percentile','stddev','variance','sum-where','count-where','cum-sum','cum-count','share','expr'];
    var MYSQL_UNSUPPORTED = {};
    var NON_REAGGREGABLE = { median: 1, percentile: 1, stddev: 1, variance: 1, distinct: 1, share: 1, 'cum-sum': 1, 'cum-count': 1, expr: 1 };
  `;

  const extracted = names.map(n => {
    try { return extractFunctionSource(src, n); } catch (e) { return '// [extract failed: ' + n + ']\n'; }
  }).join('\n\n');

  // Methods: extracted source starts with "NAME(args) {" — prepend "function "
  const methodsExtracted = methods.map(n => {
    try { return 'function ' + extractFunctionSource(src, n); }
    catch (e) { return '// [extract method failed: ' + n + ']\n'; }
  }).join('\n\n');

  const allNames = names.concat(methods);
  const exportsBlock = 'return { ' + allNames.join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  const factory = new Function(preamble + '\n' + extracted + '\n\n' + methodsExtracted + '\n' + exportsBlock);
  return factory();
}

// Load frontend helpers by extracting Pratt parser + a few helpers from inject.js.
// Frontend has an IIFE; we'd need DOM stubs. We extract specific top-level helpers
// declared inside the IIFE — need to strip IIFE wrapping.
function loadFrontendHelpers() {
  const src = readFile(INJECT_PATH);

  const names = [
    // Pratt parser
    'tokenizeExpr',
    'parseExpr',
    'validateExpression',
    'evalExpression',
    // AGG helpers
    '_percentile',
    '_variance',
    '_toNums',
    // Config + reshape
    '_newMeasureId',
    'normalizeConfig',
    'reshapeBackendRows',
    // CF helpers (nested inside render but findable by name)
    '_hexToRgb',
    '_interpolateColor',
  ];

  const preamble = `
    // Mocked browser globals
    var document = { querySelector: () => null, querySelectorAll: () => [] };
    var window = {};
    var AGG_CALL_NAMES = { SUM: 1, AVG: 1, COUNT: 1, MIN: 1, MAX: 1, COUNT_DISTINCT: 1 };
    // Minimal AGG_REGISTRY stub for normalizeConfig's aggregator validation
    var AGG_REGISTRY = {
      count: { label: 'Count' }, sum: { label: 'Sum' }, avg: { label: 'Average' },
      min: { label: 'Min' }, max: { label: 'Max' }, distinct: { label: 'Distinct Count' },
      median: { label: 'Median' }, percentile: { label: 'Percentile' },
      stddev: { label: 'Std Dev' }, variance: { label: 'Variance' },
      'sum-where': { label: 'Sum If' }, 'count-where': { label: 'Count If' },
      'cum-sum': { label: 'Cumulative Sum' }, 'cum-count': { label: 'Cumulative Count' },
      share: { label: 'Share' }, expr: { label: 'Expression' },
    };
  `;

  const extracted = names.map(n => {
    try { return extractFunctionSource(src, n); } catch (e) { return '// [extract failed: ' + n + ']\n'; }
  }).join('\n\n');

  const exportsBlock = 'return { ' + names.join(', ') + ' };';
  // eslint-disable-next-line no-new-func
  const factory = new Function(preamble + '\n' + extracted + '\n' + exportsBlock);
  return factory();
}

module.exports = {
  REPO,
  SERVICE_PATH,
  INJECT_PATH,
  readFile,
  extractFunctionSource,
  loadBackendHelpers,
  loadFrontendHelpers,
};
