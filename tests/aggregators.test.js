// Tests for aggregator helpers and SQL emission across aggregators + dialects.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackendHelpers, loadFrontendHelpers } = require('./helpers/extract.js');

const backend = loadBackendHelpers();
const frontend = loadFrontendHelpers();

// Mock context for buildAggSql
function ctx(kind) {
  return {
    esc: (f) => {
      if (kind === 'mssql') return '[' + f + ']';
      if (kind === 'mysql' || kind === 'mariadb' || kind === 'starrocks' || kind === 'clickhouse') return '`' + f + '`';
      return '"' + f + '"';
    },
    kind: kind || 'postgresql',
    colFields: [],
    rowFields: [],
  };
}

test('escId: dialect-specific quoting', () => {
  assert.equal(backend.escId('foo', 'mysql'), '`foo`');
  assert.equal(backend.escId('foo', 'mariadb'), '`foo`');
  assert.equal(backend.escId('foo', 'starrocks'), '`foo`');
  assert.equal(backend.escId('foo', 'clickhouse'), '`foo`');
  assert.equal(backend.escId('foo', 'mssql'), '[foo]');
  assert.equal(backend.escId('foo', 'postgresql'), '"foo"');
  assert.equal(backend.escId('foo', 'snowflake'), '"foo"');
  assert.equal(backend.escId('foo', 'bigquery'), '"foo"');
  // default → postgres-style
  assert.equal(backend.escId('foo', 'unknown'), '"foo"');
});

test('escId: strips control chars', () => {
  assert.equal(backend.escId('foo\x00bar', 'mysql'), '`foobar`');
  assert.equal(backend.escId('foo\nbar', 'mysql'), '`foobar`');
  assert.equal(backend.escId('foo\tbar', 'mysql'), '`foobar`');
});

test('escId: escapes delimiters within name', () => {
  assert.equal(backend.escId('foo`bar', 'mysql'), '`foo``bar`');
  assert.equal(backend.escId('foo"bar', 'postgresql'), '"foo""bar"');
  assert.equal(backend.escId('foo]bar', 'mssql'), '[foo]]bar]');
});

test('buildAggSql: count', () => {
  const sql = backend.buildAggSql({ aggregator: 'count' }, '_m_0', ctx('mysql'));
  assert.equal(sql, 'COUNT(*) AS `_m_0`');
});

test('buildAggSql: sum/avg/min/max', () => {
  const c = ctx('mysql');
  assert.equal(backend.buildAggSql({ aggregator: 'sum', field: 'x' }, '_m_0', c), 'SUM(`x`) AS `_m_0`');
  assert.equal(backend.buildAggSql({ aggregator: 'avg', field: 'x' }, '_m_0', c), 'AVG(`x`) AS `_m_0`');
  assert.equal(backend.buildAggSql({ aggregator: 'min', field: 'x' }, '_m_0', c), 'MIN(`x`) AS `_m_0`');
  assert.equal(backend.buildAggSql({ aggregator: 'max', field: 'x' }, '_m_0', c), 'MAX(`x`) AS `_m_0`');
});

test('buildAggSql: distinct dialect variance', () => {
  assert.equal(
    backend.buildAggSql({ aggregator: 'distinct', field: 'x' }, '_m_0', ctx('clickhouse')),
    'uniqExact(`x`) AS `_m_0`'
  );
  assert.equal(
    backend.buildAggSql({ aggregator: 'distinct', field: 'x' }, '_m_0', ctx('mysql')),
    'COUNT(DISTINCT `x`) AS `_m_0`'
  );
  assert.equal(
    backend.buildAggSql({ aggregator: 'distinct', field: 'x' }, '_m_0', ctx('postgresql')),
    'COUNT(DISTINCT "x") AS "_m_0"'
  );
});

test('buildAggSql: median dialects', () => {
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('postgresql')),
    /PERCENTILE_CONT\(0\.5\) WITHIN GROUP \(ORDER BY "x"\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('mysql')),
    /percentile_approx\(`x`, 0\.5\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('starrocks')),
    /percentile_approx\(`x`, 0\.5\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('clickhouse')),
    /quantileExact\(0\.5\)\(`x`\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('bigquery')),
    /APPROX_QUANTILES\("x", 100\)\[OFFSET\(50\)\]/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'median', field: 'x' }, '_m_0', ctx('snowflake')),
    /MEDIAN\("x"\)/
  );
});

test('buildAggSql: percentile with custom p', () => {
  const sql = backend.buildAggSql(
    { aggregator: 'percentile', field: 'x', percentile: 0.9 },
    '_m_0',
    ctx('postgresql')
  );
  assert.match(sql, /PERCENTILE_CONT\(0\.9\) WITHIN GROUP \(ORDER BY "x"\)/);
});

test('buildAggSql: percentile out-of-range falls back to 0.95', () => {
  const sql = backend.buildAggSql(
    { aggregator: 'percentile', field: 'x', percentile: 1.5 },
    '_m_0',
    ctx('postgresql')
  );
  assert.match(sql, /PERCENTILE_CONT\(0\.95\)/);
});

test('buildAggSql: stddev dialects', () => {
  assert.match(
    backend.buildAggSql({ aggregator: 'stddev', field: 'x' }, '_m_0', ctx('mssql')),
    /STDEV\(\[x\]\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'stddev', field: 'x' }, '_m_0', ctx('clickhouse')),
    /stddevSamp\(`x`\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'stddev', field: 'x' }, '_m_0', ctx('postgresql')),
    /STDDEV_SAMP\("x"\)/
  );
});

test('buildAggSql: variance dialects', () => {
  assert.match(
    backend.buildAggSql({ aggregator: 'variance', field: 'x' }, '_m_0', ctx('mssql')),
    /VAR\(\[x\]\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'variance', field: 'x' }, '_m_0', ctx('oracle')),
    /VARIANCE\("x"\)/
  );
  assert.match(
    backend.buildAggSql({ aggregator: 'variance', field: 'x' }, '_m_0', ctx('clickhouse')),
    /varSamp\(`x`\)/
  );
});

test('buildAggSql: sum-where and count-where', () => {
  const sw = backend.buildAggSql(
    { aggregator: 'sum-where', field: 'rev', where: { field: 'status', op: '=', value: 'active' } },
    '_m_0',
    ctx('mysql')
  );
  assert.match(sw, /SUM\(CASE WHEN `status` = 'active' THEN `rev` ELSE 0 END\)/);

  const cw = backend.buildAggSql(
    { aggregator: 'count-where', where: { field: 'is_paid', op: '=', value: 'true' } },
    '_m_0',
    ctx('mysql')
  );
  assert.match(cw, /SUM\(CASE WHEN `is_paid` = 'true' THEN 1 ELSE 0 END\)/);
});

test('buildAggSql: sum-where op sanitization', () => {
  // Invalid operator should fall back to '='
  const sql = backend.buildAggSql(
    { aggregator: 'sum-where', field: 'x', where: { field: 'y', op: 'OR 1=1', value: '1' } },
    '_m_0',
    ctx('mysql')
  );
  assert.match(sql, /`y` = '1'/);
});

test('buildAggSql: sum-where escapes single quotes in value', () => {
  const sql = backend.buildAggSql(
    { aggregator: 'sum-where', field: 'x', where: { field: 'y', op: '=', value: "a'b" } },
    '_m_0',
    ctx('mysql')
  );
  assert.match(sql, /`y` = 'a''b'/);
});

test('buildAggSql: cum-sum / cum-count (caller applies window)', () => {
  // For cum-sum/cum-count, buildAggSql emits the SUM/COUNT;
  // caller wraps with OVER(...). Just check the inner shape.
  const cs = backend.buildAggSql({ aggregator: 'cum-sum', field: 'x' }, '_m_0', ctx('mysql'));
  assert.match(cs, /SUM\(`x`\)/);
  const cc = backend.buildAggSql({ aggregator: 'cum-count' }, '_m_0', ctx('mysql'));
  assert.match(cc, /COUNT\(\*\)/);
});

test('buildAggSql: share emits SUM (denominator handled elsewhere)', () => {
  const sql = backend.buildAggSql({ aggregator: 'share', field: 'x' }, '_m_0', ctx('mysql'));
  assert.match(sql, /SUM\(`x`\)/);
});

test('buildAggSql: expr compiles expression to SQL', () => {
  const sql = backend.buildAggSql(
    { aggregator: 'expr', expression: 'SUM(a) - SUM(b)' },
    '_m_0',
    ctx('postgresql')
  );
  assert.match(sql, /SUM\("a"\)\s*-\s*SUM\("b"\)/);
});

test('buildAggSql: expr rejects malformed', () => {
  assert.throws(
    () => backend.buildAggSql({ aggregator: 'expr', expression: 'SUM(' }, '_m_0', ctx('postgresql')),
    /Invalid expression/
  );
});

test('buildAggSql: unknown aggregator defaults to COUNT(*)', () => {
  const sql = backend.buildAggSql({ aggregator: 'bogus' }, '_m_0', ctx('mysql'));
  assert.match(sql, /^COUNT\(\*\)/);
});

// --- Frontend aggregator helpers ---

test('frontend._toNums: filters and parses', () => {
  assert.deepEqual(frontend._toNums([1, 2, '3', 'x', null, undefined, 0]), [1, 2, 3, 0]);
  assert.deepEqual(frontend._toNums([]), []);
  assert.deepEqual(frontend._toNums([Infinity, -Infinity, NaN, 5]), [5]);
});

test('frontend._percentile: known values', () => {
  assert.equal(frontend._percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(frontend._percentile([10, 20, 30, 40], 0.75), 32.5);
  assert.equal(frontend._percentile([], 0.5), 0);
  assert.equal(frontend._percentile([42], 0.5), 42);
});

test('frontend._variance: sample variance', () => {
  // For [1,2,3,4,5], sample variance = 2.5
  assert.equal(frontend._variance([1, 2, 3, 4, 5]), 2.5);
  assert.equal(frontend._variance([5, 5, 5, 5]), 0);
  assert.equal(frontend._variance([]), 0);
  assert.equal(frontend._variance([7]), 0);
});
