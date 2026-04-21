// Tests for _buildPivotSql, _buildGrandTotalSql, _buildSubtotalSql
// Verifies SQL structure for various configs, dialects, pagination, sort.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackendHelpers } = require('./helpers/extract.js');

const backend = loadBackendHelpers();
const ORIG = 'SELECT * FROM demo.t';

function cfg(over) {
  return Object.assign({
    rowFields: ['region'],
    colFields: [],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
  }, over || {});
}

function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// --- Basic builds ---

test('buildPivotSql: row only + sum, no pagination', () => {
  const sql = backend._buildPivotSql(ORIG, cfg(), 0, 0, 'mysql');
  const c = collapse(sql);
  assert.match(c, /SELECT `region`/);
  assert.match(c, /SUM\(`revenue`\) AS `_pivot_m_0`/);
  assert.match(c, /GROUP BY `region`/);
  assert.match(c, /ORDER BY `region`$/);
  assert.doesNotMatch(c, /LIMIT/);
});

test('buildPivotSql: row + col + sum', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({ colFields: ['country'] }), 0, 0, 'mysql');
  const c = collapse(sql);
  assert.match(c, /SELECT `region`, `country`/);
  assert.match(c, /GROUP BY `region`, `country`/);
});

test('buildPivotSql: multiple measures emit separate aggregates', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({
    measures: [
      { aggregator: 'sum', field: 'revenue' },
      { aggregator: 'count' },
      { aggregator: 'avg', field: 'quantity' },
    ],
  }), 0, 0, 'mysql');
  const c = collapse(sql);
  assert.match(c, /SUM\(`revenue`\) AS `_pivot_m_0`/);
  assert.match(c, /COUNT\(\*\) AS `_pivot_m_1`/);
  assert.match(c, /AVG\(`quantity`\) AS `_pivot_m_2`/);
});

test('buildPivotSql: pagination with rowFields only uses LIMIT/OFFSET', () => {
  const sql = backend._buildPivotSql(ORIG, cfg(), 2, 10, 'mysql');
  const c = collapse(sql);
  assert.match(c, /LIMIT 10 OFFSET 20/);
});

test('buildPivotSql: pagination with row+col uses DENSE_RANK', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({ colFields: ['country'] }), 0, 10, 'mysql');
  const c = collapse(sql);
  assert.match(c, /DENSE_RANK\(\) OVER \(ORDER BY `region`\)/);
  assert.match(c, /`_pivot_row_rank` > 0/);
  assert.match(c, /`_pivot_row_rank` <= 10/);
});

test('buildPivotSql: pagination page 1 computes correct offset', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({ colFields: ['country'] }), 1, 10, 'mysql');
  const c = collapse(sql);
  assert.match(c, /`_pivot_row_rank` > 10/);
  assert.match(c, /`_pivot_row_rank` <= 20/);
});

// --- Cumulative aggregator wraps in window ---

test('buildPivotSql: cum-sum wraps in window function', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({
    measures: [{ aggregator: 'cum-sum', field: 'revenue' }],
  }), 0, 0, 'postgresql');
  const c = collapse(sql);
  assert.match(c, /SUM\("_pivot_m_0"\) OVER \(.*ROWS UNBOUNDED PRECEDING\)/);
});

// --- Dialect-specific quoting ---

test('buildPivotSql: postgresql uses double-quote escaping', () => {
  const sql = backend._buildPivotSql(ORIG, cfg(), 0, 0, 'postgresql');
  assert.match(sql, /"region"/);
  assert.match(sql, /"_pivot_m_0"/);
});

test('buildPivotSql: mssql uses bracket escaping', () => {
  const sql = backend._buildPivotSql(ORIG, cfg(), 0, 0, 'mssql');
  assert.match(sql, /\[region\]/);
  assert.match(sql, /\[_pivot_m_0\]/);
});

test('buildPivotSql: clickhouse uses backtick escaping', () => {
  const sql = backend._buildPivotSql(ORIG, cfg(), 0, 0, 'clickhouse');
  assert.match(sql, /`region`/);
});

// --- Sort: row:N ---

test('buildPivotSql: sort row:0 changes ORDER BY', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({
    rowFields: ['region', 'country'],
    sort: { key: 'row:1', direction: 'desc' },
  }), 0, 0, 'mysql');
  const c = collapse(sql);
  // Final ORDER BY should start with `country` DESC
  assert.match(c, /ORDER BY `country` DESC/);
});

test('buildPivotSql: sort row with pagination affects DENSE_RANK ORDER BY', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({
    rowFields: ['region'],
    colFields: ['country'],
    sort: { key: 'row:0', direction: 'asc' },
  }), 0, 10, 'mysql');
  const c = collapse(sql);
  assert.match(c, /DENSE_RANK\(\) OVER \(ORDER BY `region` ASC\)/);
});

// --- Sort: rowTotal:mi ---

test('buildPivotSql: sort rowTotal wraps in window subquery', () => {
  const sql = backend._buildPivotSql(ORIG, cfg({
    colFields: ['country'],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
    sort: { key: 'rowTotal:0', direction: 'desc' },
  }), 0, 0, 'mysql');
  const c = collapse(sql);
  assert.match(c, /SUM\(`_pivot_m_0`\) OVER \(PARTITION BY `region`\s*\) AS `_sort_key`/);
  assert.match(c, /ORDER BY `_sort_key` DESC/);
});

// --- Input validation / edge cases ---

test('buildPivotSql: rejects no row or col fields', () => {
  assert.throws(
    () => backend._buildPivotSql(ORIG, { rowFields: [], colFields: [], measures: [{ aggregator: 'count' }] }, 0, 0, 'mysql'),
    /At least one row or column field required/i
  );
});

test('buildPivotSql: trailing semicolon in original SQL is stripped', () => {
  const sql = backend._buildPivotSql('SELECT * FROM t;', cfg(), 0, 0, 'mysql');
  const c = collapse(sql);
  // Semicolon should not appear inside subquery block
  assert.ok(!/FROM \(\s*SELECT \* FROM t;\s*\)/.test(c), 'semicolon was not stripped');
});

test('buildPivotSql: col-only (no row) skips DENSE_RANK', () => {
  const sql = backend._buildPivotSql(ORIG, {
    rowFields: [],
    colFields: ['region'],
    measures: [{ aggregator: 'count' }],
  }, 0, 10, 'mysql');
  const c = collapse(sql);
  assert.doesNotMatch(c, /DENSE_RANK/);
  assert.match(c, /LIMIT 10 OFFSET 0/);
});

// --- Grand Total SQL ---

test('buildGrandTotalSql: aggregates per colValue', () => {
  const sql = backend._buildGrandTotalSql(ORIG, {
    rowFields: ['region'],
    colFields: ['country'],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
  }, 'mysql');
  const c = collapse(sql);
  assert.match(c, /SELECT `country`/);
  assert.match(c, /GROUP BY `country`/);
  assert.match(c, /SUM\(`revenue`\)/);
});

test('buildGrandTotalSql: no col fields → single overall row (no GROUP BY)', () => {
  const sql = backend._buildGrandTotalSql(ORIG, {
    rowFields: ['region'],
    colFields: [],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
  }, 'mysql');
  const c = collapse(sql);
  assert.doesNotMatch(c, /GROUP BY/);
  assert.match(c, /SUM\(`revenue`\)/);
});

// --- Subtotal SQL ---

test('buildSubtotalSql: emits GROUP BY for all prefix row fields + col fields', () => {
  const sql = backend._buildSubtotalSql(ORIG, {
    rowFields: ['region', 'country'],
    colFields: ['channel'],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
  }, 'mysql', ['region'], ['channel']);
  const c = collapse(sql);
  assert.match(c, /SELECT `region`, `channel`/);
  assert.match(c, /GROUP BY `region`, `channel`/);
});

test('buildSubtotalSql: with empty colFields aggregates overall per prefix', () => {
  const sql = backend._buildSubtotalSql(ORIG, {
    rowFields: ['region', 'country'],
    colFields: [],
    measures: [{ aggregator: 'sum', field: 'revenue' }],
  }, 'mysql', ['region'], []);
  const c = collapse(sql);
  assert.match(c, /GROUP BY `region`/);
  assert.doesNotMatch(c, /`country`/);
});

// --- SQL injection defenses ---

test('buildPivotSql: strips control chars from field names (defense-in-depth)', () => {
  // This relies on escId stripping. Config-level field pattern validation happens in executePivot.
  const sql = backend._buildPivotSql(ORIG, cfg({ rowFields: ['foo\nbar'] }), 0, 0, 'mysql');
  // The field name should appear as `foobar` (control chars stripped)
  assert.match(sql, /`foobar`/);
  assert.doesNotMatch(sql, /`foo[\s]bar`/);
});
