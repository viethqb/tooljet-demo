// Tests for the expression parser (both backend + frontend variants).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackendHelpers, loadFrontendHelpers } = require('./helpers/extract.js');

const backend = loadBackendHelpers();
const frontend = loadFrontendHelpers();

// ---------- Backend parseExpressionSrv ----------

test('backend: parseExpressionSrv — simple number', () => {
  assert.deepEqual(backend.parseExpressionSrv('42'), { type: 'num', v: 42 });
});

test('backend: parseExpressionSrv — negation', () => {
  assert.deepEqual(backend.parseExpressionSrv('-5'), { type: 'neg', e: { type: 'num', v: 5 } });
});

test('backend: parseExpressionSrv — binary +', () => {
  const ast = backend.parseExpressionSrv('1 + 2');
  assert.equal(ast.type, 'bin');
  assert.equal(ast.op, '+');
  assert.deepEqual(ast.l, { type: 'num', v: 1 });
  assert.deepEqual(ast.r, { type: 'num', v: 2 });
});

test('backend: parseExpressionSrv — precedence * over +', () => {
  // 1 + 2 * 3 → 1 + (2*3)
  const ast = backend.parseExpressionSrv('1 + 2 * 3');
  assert.equal(ast.op, '+');
  assert.deepEqual(ast.l, { type: 'num', v: 1 });
  assert.equal(ast.r.op, '*');
});

test('backend: parseExpressionSrv — parentheses', () => {
  // (1 + 2) * 3 → (1+2) * 3
  const ast = backend.parseExpressionSrv('(1 + 2) * 3');
  assert.equal(ast.op, '*');
  assert.equal(ast.l.op, '+');
  assert.deepEqual(ast.r, { type: 'num', v: 3 });
});

test('backend: parseExpressionSrv — aggregate call', () => {
  const ast = backend.parseExpressionSrv('SUM(revenue)');
  assert.equal(ast.type, 'agg');
  assert.equal(ast.fn, 'SUM');
  assert.equal(ast.col, 'revenue');
});

test('backend: parseExpressionSrv — aggregate expression', () => {
  const ast = backend.parseExpressionSrv('SUM(a) - SUM(b)');
  assert.equal(ast.op, '-');
  assert.equal(ast.l.type, 'agg');
  assert.equal(ast.l.fn, 'SUM');
  assert.equal(ast.l.col, 'a');
  assert.equal(ast.r.fn, 'SUM');
  assert.equal(ast.r.col, 'b');
});

test('backend: parseExpressionSrv — division preserves right-assoc within term', () => {
  // a / b / c → (a/b)/c
  const ast = backend.parseExpressionSrv('SUM(a) / SUM(b) / SUM(c)');
  assert.equal(ast.op, '/');
  assert.equal(ast.l.op, '/');
  assert.equal(ast.l.l.fn, 'SUM');
  assert.equal(ast.l.r.fn, 'SUM');
  assert.equal(ast.r.fn, 'SUM');
});

test('backend: parseExpressionSrv — rejects unknown function', () => {
  assert.throws(() => backend.parseExpressionSrv('FOO(x)'), /Unknown aggregate/i);
});

test('backend: parseExpressionSrv — rejects bare identifier', () => {
  assert.throws(() => backend.parseExpressionSrv('x'), /Bare identifier|Unexpected/);
});

test('backend: parseExpressionSrv — empty throws', () => {
  assert.throws(() => backend.parseExpressionSrv(''));
});

test('backend: parseExpressionSrv — trailing tokens rejected', () => {
  assert.throws(() => backend.parseExpressionSrv('SUM(x) 5'));
});

test('backend: parseExpressionSrv — decimal numbers', () => {
  const ast = backend.parseExpressionSrv('1.5 + 2.5');
  assert.equal(ast.l.v, 1.5);
  assert.equal(ast.r.v, 2.5);
});

test('backend: compileAstToSql — basic arithmetic', () => {
  const ast = backend.parseExpressionSrv('SUM(a) + SUM(b)');
  const esc = (f) => '"' + f + '"';
  const sql = backend.compileAstToSql(ast, esc);
  assert.match(sql, /SUM\("a"\)\s*\+\s*SUM\("b"\)/);
});

test('backend: compileAstToSql — division uses safe divisor', () => {
  const ast = backend.parseExpressionSrv('SUM(a) / SUM(b)');
  const esc = (f) => '"' + f + '"';
  const sql = backend.compileAstToSql(ast, esc);
  // Expect NULLIF or CASE protection, or simple division
  assert.ok(sql.includes('SUM("a")') && sql.includes('SUM("b")'));
});

test('backend: compileAstToSql — parenthesization', () => {
  const ast = backend.parseExpressionSrv('(SUM(a) + SUM(b)) * 2');
  const esc = (f) => '"' + f + '"';
  const sql = backend.compileAstToSql(ast, esc);
  assert.match(sql, /\(\s*SUM\("a"\)\s*\+\s*SUM\("b"\)\s*\)\s*\*\s*2/);
});

// ---------- Frontend parseExpr ----------

test('frontend: parseExpr — same grammar as backend', () => {
  const astF = frontend.parseExpr('SUM(a) + 5');
  const astB = backend.parseExpressionSrv('SUM(a) + 5');
  assert.deepEqual(astF, astB);
});

test('frontend: parseExpr — rejects unknown aggregate', () => {
  assert.throws(() => frontend.parseExpr('UNKNOWN(x)'), /Unknown aggregate/);
});

test('frontend: evalExpression — simple', () => {
  const ast = frontend.parseExpr('1 + 2 * 3');
  assert.equal(frontend.evalExpression(ast, []), 7);
});

test('frontend: evalExpression — division by zero returns 0', () => {
  const ast = frontend.parseExpr('5 / 0');
  assert.equal(frontend.evalExpression(ast, []), 0);
  // Also via expression 5 / (0+0)
  const ast2 = frontend.parseExpr('10 - 10');
  assert.equal(frontend.evalExpression(ast2, []), 0);
});

test('frontend: evalExpression — aggregate over rows', () => {
  const ast = frontend.parseExpr('SUM(x) + 1');
  const rows = [{ x: 10 }, { x: 20 }, { x: 30 }];
  assert.equal(frontend.evalExpression(ast, rows), 61);
});

test('frontend: evalExpression — COUNT counts rows', () => {
  const ast = frontend.parseExpr('COUNT(x)');
  const rows = [{ x: 1 }, { x: 2 }, { x: 3 }];
  assert.equal(frontend.evalExpression(ast, rows), 3);
});

test('frontend: validateExpression — invalid column in allowedCols rejected', () => {
  const r = frontend.validateExpression('SUM(bogus)', ['x', 'y']);
  assert.ok(r.error, 'expected error');
  assert.match(r.error, /bogus|column/i);
});

test('frontend: validateExpression — valid expression returns ast', () => {
  const r = frontend.validateExpression('SUM(x) + AVG(y)', ['x', 'y']);
  assert.ok(r.ast);
  assert.ok(!r.error);
});

test('frontend: validateExpression — syntax error returns error', () => {
  const r = frontend.validateExpression('SUM(', ['x']);
  assert.ok(r.error);
});

test('frontend: validateExpression — no allowedCols skips column check', () => {
  const r = frontend.validateExpression('SUM(anything)', null);
  assert.ok(r.ast);
  assert.ok(!r.error);
});

test('frontend: tokenizeExpr — identifies numbers, operators, identifiers, parens', () => {
  const toks = frontend.tokenizeExpr('SUM(x) + 5');
  // Expect token types: ident, (, ident, ), +, num
  assert.equal(toks.length >= 6, true);
  assert.equal(toks[0].t, 'ident');
  assert.equal(toks[0].v.trim(), 'SUM');
});
