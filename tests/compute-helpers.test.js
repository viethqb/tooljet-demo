// Tests for config normalization, reshape, and conditional-formatting color helpers.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontendHelpers } = require('./helpers/extract.js');

const f = loadFrontendHelpers();

// ---------- normalizeConfig ----------

test('normalizeConfig: migrates legacy valueField/aggregator to measures', () => {
  const c = { valueField: 'revenue', aggregator: 'sum' };
  f.normalizeConfig(c);
  assert.equal(c.measures.length, 1);
  assert.equal(c.measures[0].field, 'revenue');
  assert.equal(c.measures[0].aggregator, 'sum');
  assert.ok(c.measures[0].id);
});

test('normalizeConfig: defaults empty measures to count', () => {
  const c = {};
  f.normalizeConfig(c);
  assert.equal(c.measures[0].aggregator, 'count');
});

test('normalizeConfig: adds missing measure ids', () => {
  const c = { measures: [{ aggregator: 'sum', field: 'x' }] };
  f.normalizeConfig(c);
  assert.ok(c.measures[0].id);
});

test('normalizeConfig: unknown aggregator falls back to count', () => {
  const c = { measures: [{ aggregator: 'bogus', field: 'x' }] };
  f.normalizeConfig(c);
  assert.equal(c.measures[0].aggregator, 'count');
});

test('normalizeConfig: mirrors first measure to legacy valueField/aggregator', () => {
  const c = { measures: [{ aggregator: 'avg', field: 'price' }] };
  f.normalizeConfig(c);
  assert.equal(c.valueField, 'price');
  assert.equal(c.aggregator, 'avg');
});

test('normalizeConfig: defaults conditionalFormats to empty array', () => {
  const c = { measures: [{ aggregator: 'count' }] };
  f.normalizeConfig(c);
  assert.deepEqual(c.conditionalFormats, []);
});

test('normalizeConfig: drops sort referencing invalid measure index', () => {
  const c = {
    measures: [{ aggregator: 'sum', field: 'x', id: 'm1' }],
    sort: { key: 'rowTotal:5', direction: 'desc' },
  };
  f.normalizeConfig(c);
  assert.equal(c.sort, null);
});

test('normalizeConfig: drops sort referencing invalid row field index', () => {
  const c = {
    rowFields: ['region'],
    measures: [{ aggregator: 'count' }],
    sort: { key: 'row:5', direction: 'asc' },
  };
  f.normalizeConfig(c);
  assert.equal(c.sort, null);
});

test('normalizeConfig: keeps valid sort', () => {
  const c = {
    rowFields: ['region'],
    measures: [{ aggregator: 'sum', field: 'x', id: 'm1' }],
    sort: { key: 'rowTotal:0', direction: 'desc' },
  };
  f.normalizeConfig(c);
  assert.deepEqual(c.sort, { key: 'rowTotal:0', direction: 'desc' });
});

test('normalizeConfig: drops sort with missing key or direction', () => {
  const c = { measures: [{ aggregator: 'count' }], sort: { key: 'row:0' } };
  f.normalizeConfig(c);
  assert.equal(c.sort, null);
});

test('normalizeConfig: filters CF rules referencing removed measures', () => {
  const c = {
    measures: [{ aggregator: 'sum', field: 'x', id: 'm1' }],
    conditionalFormats: [
      { id: 'cf1', type: 'threshold', measureId: 'ghost', bgColor: '#fff' },
      { id: 'cf2', type: 'threshold', measureId: 'm1', bgColor: '#fff' },
      { id: 'cf3', type: 'threshold', measureId: 'all', bgColor: '#fff' },
    ],
  };
  f.normalizeConfig(c);
  assert.equal(c.conditionalFormats.length, 2);
  const ids = c.conditionalFormats.map(r => r.id);
  assert.deepEqual(ids, ['cf2', 'cf3']);
});

test('normalizeConfig: fills CF defaults', () => {
  const c = {
    measures: [{ aggregator: 'count', id: 'm1' }],
    conditionalFormats: [{}],
  };
  f.normalizeConfig(c);
  const cf = c.conditionalFormats[0];
  assert.equal(cf.type, 'threshold');
  assert.equal(cf.measureId, 'all');
  assert.equal(cf.operator, '>');
  assert.ok(cf.bgColor);
  assert.equal(cf.applyToTotals, false);
  assert.ok(cf.id);
});

// ---------- reshapeBackendRows ----------

test('reshapeBackendRows: single measure maps _pivot_value to field', () => {
  const rows = [
    { region: 'APAC', _pivot_m_0: 100, _pivot_value: 100, _pivot_count: 5, _pivot_mc_0: 5 },
    { region: 'EU', _pivot_m_0: 200, _pivot_value: 200, _pivot_count: 10, _pivot_mc_0: 10 },
  ];
  const cfg = { rowFields: ['region'], colFields: [], measures: [{ aggregator: 'sum', field: 'revenue', id: 'm1' }] };
  const reshaped = f.reshapeBackendRows(rows, cfg);
  assert.equal(reshaped.length, 2);
  assert.equal(reshaped[0].region, 'APAC');
  // Single measure: stored under field name
  assert.equal(reshaped[0].revenue, 100);
  assert.equal(reshaped[0]._pivot_count, 5);
});

test('reshapeBackendRows: multi-measure uses synthetic __m_<id> keys', () => {
  const rows = [
    { region: 'APAC', _pivot_m_0: 100, _pivot_m_1: 5, _pivot_value: 100, _pivot_count: 5, _pivot_mc_0: 5, _pivot_mc_1: 5 },
  ];
  const cfg = {
    rowFields: ['region'],
    colFields: [],
    measures: [
      { aggregator: 'sum', field: 'revenue', id: 'm1' },
      { aggregator: 'count', id: 'm2' },
    ],
  };
  const reshaped = f.reshapeBackendRows(rows, cfg);
  assert.equal(reshaped[0]['__m_m1'], 100);
  assert.equal(reshaped[0]['__m_m2'], 5);
  // First measure also mirrors to its field name
  assert.equal(reshaped[0].revenue, 100);
});

test('reshapeBackendRows: strips internal _pivot_m_N / _pivot_mc_N keys', () => {
  const rows = [{ region: 'APAC', _pivot_m_0: 100, _pivot_mc_0: 5, _pivot_value: 100, _pivot_count: 5 }];
  const cfg = { rowFields: ['region'], measures: [{ aggregator: 'sum', field: 'rev', id: 'm1' }] };
  const reshaped = f.reshapeBackendRows(rows, cfg);
  assert.equal(reshaped[0]._pivot_m_0, undefined);
  assert.equal(reshaped[0]._pivot_mc_0, undefined);
});

// ---------- Hex color + interpolation ----------

test('_hexToRgb: valid 6-digit', () => {
  assert.deepEqual(f._hexToRgb('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(f._hexToRgb('#00ff00'), { r: 0, g: 255, b: 0 });
  assert.deepEqual(f._hexToRgb('#0000ff'), { r: 0, g: 0, b: 255 });
});

test('_hexToRgb: valid 3-digit (shorthand)', () => {
  assert.deepEqual(f._hexToRgb('#f00'), { r: 255, g: 0, b: 0 });
});

test('_hexToRgb: invalid hex falls back to white', () => {
  assert.deepEqual(f._hexToRgb('not-a-hex'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(f._hexToRgb(''), { r: 255, g: 255, b: 255 });
  assert.deepEqual(f._hexToRgb('#xyzxyz'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(f._hexToRgb(undefined), { r: 255, g: 255, b: 255 });
  assert.deepEqual(f._hexToRgb(null), { r: 255, g: 255, b: 255 });
});

test('_hexToRgb: case-insensitive', () => {
  assert.deepEqual(f._hexToRgb('#ABCDEF'), f._hexToRgb('#abcdef'));
});

test('_interpolateColor: t=0 returns c1', () => {
  assert.equal(f._interpolateColor('#000000', '#ffffff', 0), 'rgb(0,0,0)');
});

test('_interpolateColor: t=1 returns c2', () => {
  assert.equal(f._interpolateColor('#000000', '#ffffff', 1), 'rgb(255,255,255)');
});

test('_interpolateColor: t=0.5 midpoint', () => {
  assert.equal(f._interpolateColor('#000000', '#ffffff', 0.5), 'rgb(128,128,128)');
});

test('_interpolateColor: t clamped to [0,1]', () => {
  assert.equal(f._interpolateColor('#000000', '#ffffff', -1), 'rgb(0,0,0)');
  assert.equal(f._interpolateColor('#000000', '#ffffff', 2), 'rgb(255,255,255)');
});

test('_interpolateColor: handles different colors', () => {
  // Red to green midpoint
  const mid = f._interpolateColor('#ff0000', '#00ff00', 0.5);
  assert.equal(mid, 'rgb(128,128,0)');
});

// ---------- _newMeasureId ----------

test('_newMeasureId: generates unique ids with m_ prefix', () => {
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    const id = f._newMeasureId();
    assert.match(id, /^m_[a-z0-9]+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});
