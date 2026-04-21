/**
 * Pivot Table - Frontend Injection Script
 * - Editor: Injects "Pivot Table" config section into Inspector properties panel
 * - Viewer: Auto-renders pivot table (read-only) replacing normal table view
 *
 * Storage: API (/api/pivot-table-config) with localStorage fallback
 */
(function () {
  'use strict';

  var LOG_PREFIX = '[PivotTable]';

  // ===================== MODE DETECTION =====================
  var path = window.location.pathname;
  var editorMatch = path.match(/\/apps\/([^/]+)/);
  var viewerMatch = path.match(/\/applications\/([^/]+)/);
  var isEditor = !!editorMatch;
  var isViewer = !!viewerMatch;
  var appSlug = editorMatch?.[1] || viewerMatch?.[1] || null;

  if (!appSlug) return;
  console.log(LOG_PREFIX, isEditor ? 'Editor' : 'Viewer', 'mode, app:', appSlug);

  // ===================== UTILS =====================
  // Detect ISO date-time strings and shorten to 'YYYY-MM-DD' (pretty-print for row labels)
  var _isoDateRe = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  function esc(s) {
    var str = String(s ?? '');
    var m = str.match(_isoDateRe);
    // If midnight UTC and time is 00:00:00.000Z → show as date only
    if (m && /T00:00:00(\.0+)?Z$/.test(str)) str = m[1];
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ===================== API + STORAGE =====================
  var _workspaceId = null;
  var _appVersionId = null;
  var _origFetch = window.fetch;

  // Intercept fetch to capture workspace ID and app version ID
  window.fetch = function () {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] instanceof Request ? args[0].url : '');
    var opts = args[1] || {};

    // Capture workspace ID from headers
    if (opts.headers) {
      var wid = opts.headers instanceof Headers ? opts.headers.get('tj-workspace-id') : opts.headers['tj-workspace-id'];
      if (wid) _workspaceId = wid;
    }

    // Capture version ID from /api/data-queries/:versionId (same pattern as query-folders)
    var vMatch = url.match(/\/api\/data-queries\/([a-f0-9-]{36})(?:\?|$)/);
    if (vMatch) {
      _appVersionId = vMatch[1];
    }

    // Also from /api/v2/apps/:appId/versions/:versionId/...
    var v2Match = url.match(/\/api\/(?:v2\/)?apps\/[^/]+\/versions\/([0-9a-f-]{36})/);
    if (v2Match) _appVersionId = v2Match[1];

    // Also from ?app_version_id=UUID query parameter
    var qpMatch = url.match(/[?&]app_version_id=([0-9a-f-]{36})/);
    if (qpMatch) _appVersionId = qpMatch[1];

    // Intercept data-queries run responses to capture actual data
    var result = _origFetch.apply(this, args);
    if (url.match(/\/api\/data-queries\/.*\/run/)) {
      result.then(function (response) {
        if (response.ok) {
          response.clone().json().then(function (json) {
            // Store query result data: { data: [...rows...] }
            var queryData = null;
            if (json && json.data && Array.isArray(json.data)) {
              queryData = json.data;
            } else if (json && json.data && json.data.data && Array.isArray(json.data.data)) {
              queryData = json.data.data;
            }
            if (queryData && queryData.length > 0) {
              // Extract query ID from URL to build cache key
              var qIdMatch = url.match(/\/api\/data-queries\/([a-f0-9-]+)\/.*\/run/);
              if (qIdMatch) {
                _queryDataCache[qIdMatch[1]] = queryData;
                console.log(LOG_PREFIX, 'Cached query data:', qIdMatch[1], queryData.length, 'rows');
              }
            }
          }).catch(function () {});
        }
      }).catch(function () {});
    }
    return result;
  };

  // Cache for intercepted query data (queryId -> data[])
  var _queryDataCache = {};

  // Reshape backend pivot rows into a flat data array consumable by computePivot.
  // Handles both legacy single-measure (_pivot_value) and multi-measure (_pivot_m_0, _pivot_m_1, ...).
  function reshapeBackendRows(rows, config) {
    normalizeConfig(config);
    var measures = config.measures;
    var isMulti = measures.length > 1;
    return rows.map(function (row) {
      var r = {};
      for (var k in row) {
        if (k === '_pivot_value' || k === '_pivot_row_rank' || k === '_pivot_count') continue;
        if (/^_pivot_m_\d+$/.test(k)) continue;
        if (/^_pivot_mc_\d+$/.test(k)) continue;
        r[k] = row[k];
      }
      if (isMulti) {
        for (var mi = 0; mi < measures.length; mi++) {
          var m = measures[mi];
          var val = row['_pivot_m_' + mi];
          if (val === undefined) val = row['_pivot_value'];
          // Primary storage: synthetic per-measure key (collision-safe)
          r['__m_' + m.id] = val;
          // Mirror to field name too (first-come wins; for display in traditional sense)
          if (m.field && r[m.field] === undefined) r[m.field] = val;
        }
        r['_pivot_value'] = row['_pivot_m_0'] !== undefined ? row['_pivot_m_0'] : row['_pivot_value'];
        if (row['_pivot_mc_0'] !== undefined) r['_pivot_count'] = row['_pivot_mc_0'];
      } else {
        var primary = config.valueField || measures[0].field || '_count';
        r[primary] = row['_pivot_value'];
        if (row['_pivot_count'] !== undefined) r['_pivot_count'] = row['_pivot_count'];
      }
      return r;
    });
  }

  // Detect app version ID from multiple sources (called when needed)
  function detectAppVersionId() {
    if (_appVersionId) return _appVersionId;

    // Fallback 1: performance entries (API calls that happened before our script loaded)
    try {
      var perfEntries = performance.getEntriesByType('resource');
      for (var i = perfEntries.length - 1; i >= 0; i--) {
        var match = perfEntries[i].name.match(/\/api\/data-queries\/([a-f0-9-]{36})(?:\?|$)/);
        if (match) { _appVersionId = match[1]; return _appVersionId; }
      }
    } catch (_) {}

    // Fallback 2: React fiber → Zustand store currentVersionId
    try {
      var el = document.getElementById('query-manager') || document.getElementById('canvas');
      if (el) {
        var fiberKey = Object.keys(el).find(function (k) { return k.startsWith('__reactFiber'); });
        if (fiberKey) {
          var fiber = el[fiberKey];
          for (var j = 0; j < 50 && fiber; j++) {
            var store = (fiber.memoizedProps && fiber.memoizedProps.store) ||
                        (fiber.pendingProps && fiber.pendingProps.store);
            if (store && store.getState) {
              var state = store.getState();
              if (state && state.currentVersionId) {
                _appVersionId = state.currentVersionId;
                return _appVersionId;
              }
            }
            fiber = fiber.return;
          }
        }
      }
    } catch (_) {}

    return null;
  }

  function apiFetch(apiPath, options) {
    var headers = { 'Content-Type': 'application/json' };
    if (_workspaceId) headers['tj-workspace-id'] = _workspaceId;

    return _origFetch('/api/pivot-table-config' + apiPath, Object.assign({
      credentials: 'include',
      headers: headers,
    }, options || {}));
  }

  // localStorage fallback — use component_id in key when available for multi-page safety
  function storageKey(name) {
    var cid = _componentIdMap[name];
    return 'pivot__' + appSlug + '__' + (cid || name);
  }

  function saveConfigLocal(name, config) {
    try { localStorage.setItem(storageKey(name), JSON.stringify(config)); } catch (_) {}
  }

  function loadConfigLocal(name) {
    try {
      var raw = localStorage.getItem(storageKey(name));
      if (raw) return normalizeConfig(JSON.parse(raw));
      // Only fallback to legacy key if we DON'T have a component_id
      // (means component_id hasn't been captured yet — true migration scenario)
      if (!_componentIdMap[name]) {
        var legacyRaw = localStorage.getItem('pivot__' + appSlug + '__' + name);
        return legacyRaw ? normalizeConfig(JSON.parse(legacyRaw)) : null;
      }
      return null;
    } catch (_) { return null; }
  }

  // Save to API (fire-and-forget) + localStorage backup
  function saveConfig(name, config, componentId) {
    saveConfigLocal(name, config);
    var vid = detectAppVersionId();
    if (!vid) return;
    var payload = { app_version_id: vid, component_name: name, config: config };
    if (componentId) payload.component_id = componentId;
    apiFetch('', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).catch(function (err) { console.warn(LOG_PREFIX, 'API save failed:', err.message); });
  }

  // Load from API, fallback to localStorage
  function loadConfig(name) {
    return loadConfigLocal(name); // sync fallback, async load happens on init
  }

  // Async: load single config from API
  function loadConfigAsync(name, callback) {
    var vid = detectAppVersionId();
    if (!vid) { callback(loadConfigLocal(name)); return; }
    var cid = _componentIdMap[name];
    var url = '/' + vid + '/' + encodeURIComponent(name) + (cid ? '?component_id=' + cid : '');
    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.config) {
          var cfg = normalizeConfig(data.config);
          saveConfigLocal(name, cfg); // sync localStorage
          callback(cfg);
        } else {
          // API returned null — maybe migrate from localStorage
          var local = loadConfigLocal(name);
          if (local && local.enabled) {
            saveConfig(name, local); // migrate to API
          }
          callback(local);
        }
      })
      .catch(function () { callback(loadConfigLocal(name)); });
  }

  // Async: load ALL configs for viewer mode (single API call)
  // Backend returns { configs: { componentId: { config, name, component_id } } }
  // We build a map: componentName -> config, and componentId -> componentName for multi-page
  function loadAllConfigsAsync(callback) {
    var vid = detectAppVersionId();
    if (!vid) { callback({}); return; }
    apiFetch('/' + vid)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.configs) {
          var result = {};
          var keys = Object.keys(data.configs);
          for (var i = 0; i < keys.length; i++) {
            var entry = data.configs[keys[i]];
            // New format: { config, name, component_id }
            if (entry && entry.config && entry.name) {
              var cfgName = entry.name;
              // Use component_id as key if available (multi-page safe)
              if (entry.component_id) {
                _componentIdMap[cfgName] = _componentIdMap[cfgName] || entry.component_id;
                // If same name exists, suffix with page context to avoid collision
                if (result[cfgName]) {
                  cfgName = cfgName + '__' + entry.component_id.substring(0, 8);
                }
              }
              result[cfgName] = normalizeConfig(entry.config);
              saveConfigLocal(cfgName, result[cfgName]);
            } else {
              // Legacy format: config directly
              result[keys[i]] = normalizeConfig(entry);
              saveConfigLocal(keys[i], result[keys[i]]);
            }
          }
          callback(result);
        } else {
          callback({});
        }
      })
      .catch(function () { callback({}); });
  }

  // Execute backend pivot query (auto-detects query from component's data binding)
  // page/pageSize are optional — if provided, backend adds LIMIT/OFFSET
  function executePivotAsync(componentName, config, callback, page, pageSize) {
    var vid = detectAppVersionId();
    if (!vid) { callback(new Error('App version not detected yet'), [], null); return; }
    var body = { app_version_id: vid, component_name: componentName, config: config };
    if (_componentIdMap[componentName]) body.component_id = _componentIdMap[componentName];
    if (pageSize && pageSize > 0) {
      body.page = page || 0;
      body.page_size = pageSize;
    }
    apiFetch('/execute', {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            console.log(LOG_PREFIX, 'Execute error:', r.status, t);
            var msg = 'Pivot query failed';
            try { msg = JSON.parse(t).message || msg; } catch (_) {}
            throw new Error(msg);
          });
        }
        return r.json();
      })
      .then(function (result) { callback(null, result.data || [], result.total, result.grand_totals, result.subtotals); })
      .catch(function (err) { callback(err, [], null, null, null); });
  }

  function _newMeasureId() { return 'm_' + Math.random().toString(36).slice(2, 10); }

  function defaultConfig() {
    return {
      enabled: false, rowFields: [], colFields: [], valueField: '', aggregator: 'count',
      measures: [{ id: _newMeasureId(), field: '', aggregator: 'count', label: '' }],
      showTitle: true, titleAlias: '',
      showRowTotal: true, rowTotalLabel: 'Total',
      showGrandTotal: true, grandTotalLabel: 'Grand Total',
      showSubtotal: false, subtotalLabel: '{group} Subtotal',
      backendPivot: true,
      alignRowFields: 'left', alignColValues: 'right', alignRowTotal: 'right',
      alignGrandTotal: 'right', alignSubtotal: 'right',
      styleRowFields: 'bold', styleColValues: '', styleRowTotal: '',
      styleGrandTotal: 'bold', styleSubtotal: 'bold italic',
      emptyValue: '-',
      decimalPlaces: 'auto', // 'auto' | 0 | 1 | 2 | 3 | 4 | 5 | 6
      pageSize: 0, // 0 = all
    };
  }

  // Normalize a loaded config: ensure `measures` exists, parse expressions, mirror legacy
  // Idempotent — safe to call multiple times. Returns the same object (mutates in place).
  function normalizeConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    // Ensure measures array exists (migrate from legacy valueField + aggregator)
    if (!Array.isArray(cfg.measures) || cfg.measures.length === 0) {
      cfg.measures = [{
        id: _newMeasureId(),
        field: cfg.valueField || '',
        aggregator: cfg.aggregator || 'count',
        label: '',
      }];
    }
    // Ensure each measure has an id
    for (var i = 0; i < cfg.measures.length; i++) {
      var m = cfg.measures[i];
      if (!m.id) m.id = _newMeasureId();
      if (!m.aggregator) m.aggregator = 'count';
      if (m.field === undefined) m.field = '';
      if (!AGG_REGISTRY[m.aggregator]) m.aggregator = 'count';
      // Parse expression AST for expr measures
      if (m.aggregator === 'expr' && m.expression) {
        var parsed = validateExpression(m.expression, null);
        m._ast = parsed.ast;
        m._exprError = parsed.error;
      } else {
        delete m._ast; delete m._exprError;
      }
    }
    // Mirror first measure to legacy fields for backward-compat with old clients
    cfg.valueField = cfg.measures[0].field;
    cfg.aggregator = cfg.measures[0].aggregator;
    // Sort state — { key, direction } or null. key: "row:N" | "col:<colValue>:<measureIdx>" | "rowTotal:<measureIdx>"
    if (cfg.sort && (!cfg.sort.key || !cfg.sort.direction)) cfg.sort = null;
    // Invalidate sort if it references a measure index out of range
    if (cfg.sort && cfg.sort.key) {
      var sk = String(cfg.sort.key);
      var measCount = cfg.measures.length;
      var rowFieldsCount = (cfg.rowFields || []).length;
      var _mi = -1;
      if (sk.indexOf('rowTotal:') === 0) _mi = parseInt(sk.slice('rowTotal:'.length), 10);
      else if (sk.indexOf('col:') === 0) {
        var _sep = sk.lastIndexOf('|');
        if (_sep > 0) _mi = parseInt(sk.slice(_sep + 1), 10);
      }
      if (!isNaN(_mi) && _mi >= 0 && _mi >= measCount) cfg.sort = null;
      if (sk.indexOf('row:') === 0) {
        var _ri = parseInt(sk.slice(4), 10);
        if (isNaN(_ri) || _ri < 0 || _ri >= rowFieldsCount) cfg.sort = null;
      }
    }
    // Conditional formats — default empty array; filter invalid rules
    if (!Array.isArray(cfg.conditionalFormats)) cfg.conditionalFormats = [];
    cfg.conditionalFormats = cfg.conditionalFormats.filter(function (cf) {
      if (!cf || typeof cf !== 'object') return false;
      if (cf.measureId && cf.measureId !== 'all') {
        // Drop CF rules that reference measures no longer present
        var found = false;
        for (var mi = 0; mi < cfg.measures.length; mi++) { if (cfg.measures[mi].id === cf.measureId) { found = true; break; } }
        if (!found) return false;
      }
      return true;
    });
    for (var ci = 0; ci < cfg.conditionalFormats.length; ci++) {
      var cf = cfg.conditionalFormats[ci];
      if (!cf.id) cf.id = 'cf_' + Math.random().toString(36).slice(2, 10);
      if (!cf.type) cf.type = 'threshold';
      if (!cf.measureId) cf.measureId = 'all';
      if (cf.type === 'threshold') {
        if (!cf.operator) cf.operator = '>';
        if (!cf.bgColor) cf.bgColor = '#d4f4dd';
      } else if (cf.type === 'gradient') {
        if (!cf.minColor) cf.minColor = '#ffffff';
        if (!cf.maxColor) cf.maxColor = '#22c55e';
      }
      if (typeof cf.applyToTotals !== 'boolean') cf.applyToTotals = false;
    }
    return cfg;
  }

  // ===================== PAGINATION STATE (runtime, not persisted) =====================
  var _pivotPage = {}; // componentName -> current page (0-based)

  function getPivotPage(name) {
    if (_pivotPage[name] !== undefined) return _pivotPage[name];
    try { var p = parseInt(sessionStorage.getItem('pivotPage__' + name), 10); return isNaN(p) ? 0 : p; } catch (_) { return 0; }
  }
  function setPivotPage(name, page) {
    _pivotPage[name] = page;
    try { sessionStorage.setItem('pivotPage__' + name, page); } catch (_) {}
  }

  // ===================== AGGREGATORS =====================
  // Registry: each entry has label, compute(values, rows, measure), sqlKind, reAggregate
  // reAggregate: 'simple' (sum), 'weighted' (avg with counts), 'none' (can't re-aggregate partials)
  // Cells store { val, row } tuples; the registry decides whether to use rows or just values.
  function _toNums(v) { var n = []; for (var i = 0; i < v.length; i++) { var x = parseFloat(v[i]); if (!isNaN(x) && isFinite(x)) n.push(x); } return n; }
  function _percentile(nums, p) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var idx = p * (s.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
    return s[lo] + (s[hi] - s[lo]) * frac;
  }
  function _variance(nums) {
    if (nums.length < 2) return 0;
    var m = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    var sq = 0;
    for (var i = 0; i < nums.length; i++) { var d = nums[i] - m; sq += d * d; }
    return sq / (nums.length - 1); // sample variance
  }
  function _matchWhere(row, where) {
    if (!where || !where.field) return true;
    var v = row[where.field];
    var op = where.op || '=';
    var val = where.value;
    switch (op) {
      case '=': return String(v ?? '') === String(val ?? '');
      case '!=': return String(v ?? '') !== String(val ?? '');
      case '>': return parseFloat(v) > parseFloat(val);
      case '<': return parseFloat(v) < parseFloat(val);
      case '>=': return parseFloat(v) >= parseFloat(val);
      case '<=': return parseFloat(v) <= parseFloat(val);
      case 'is null': return v === null || v === undefined || v === '';
      case 'is not null': return !(v === null || v === undefined || v === '');
      case 'like': return String(v ?? '').toLowerCase().indexOf(String(val ?? '').toLowerCase()) !== -1;
      default: return true;
    }
  }

  const AGG_REGISTRY = {
    count: {
      label: 'Count', sqlKind: 'simple', reAggregate: 'simple',
      compute: function (cells) { return cells.length; },
    },
    sum: {
      label: 'Sum', sqlKind: 'simple', reAggregate: 'simple',
      compute: function (cells) { var s = 0; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) s += x; } return s; },
    },
    avg: {
      label: 'Avg', sqlKind: 'simple', reAggregate: 'weighted',
      compute: function (cells) { var nums = []; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) nums.push(x); } return nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : 0; },
    },
    min: {
      label: 'Min', sqlKind: 'simple', reAggregate: 'min',
      compute: function (cells) { var nums = []; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) nums.push(x); } return nums.length ? Math.min.apply(null, nums) : ''; },
    },
    max: {
      label: 'Max', sqlKind: 'simple', reAggregate: 'max',
      compute: function (cells) { var nums = []; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) nums.push(x); } return nums.length ? Math.max.apply(null, nums) : ''; },
    },
    distinct: {
      label: 'Count Distinct', sqlKind: 'distinct', reAggregate: 'none',
      compute: function (cells) { var set = new Set(); for (var i = 0; i < cells.length; i++) set.add(cells[i].val); return set.size; },
    },
    median: {
      label: 'Median', sqlKind: 'quantile', reAggregate: 'none',
      compute: function (cells) { return _percentile(_toNums(cells.map(function (c) { return c.val; })), 0.5); },
    },
    percentile: {
      label: 'Percentile', sqlKind: 'quantile', reAggregate: 'none',
      compute: function (cells, rows, measure) { var p = parseFloat((measure && measure.percentile) || 0.95); if (isNaN(p) || p < 0 || p > 1) p = 0.95; return _percentile(_toNums(cells.map(function (c) { return c.val; })), p); },
    },
    stddev: {
      label: 'Std Dev', sqlKind: 'variance', reAggregate: 'none',
      compute: function (cells) { return Math.sqrt(_variance(_toNums(cells.map(function (c) { return c.val; })))); },
    },
    variance: {
      label: 'Variance', sqlKind: 'variance', reAggregate: 'none',
      compute: function (cells) { return _variance(_toNums(cells.map(function (c) { return c.val; }))); },
    },
    'sum-where': {
      label: 'Sum Where', sqlKind: 'conditional', reAggregate: 'simple',
      compute: function (cells, rows, measure) {
        var field = measure && measure.field;
        var where = measure && measure.where;
        if (!rows || !rows.length) return 0;
        var s = 0;
        for (var i = 0; i < rows.length; i++) {
          if (_matchWhere(rows[i], where)) {
            var x = parseFloat(field ? rows[i][field] : 0);
            if (!isNaN(x)) s += x;
          }
        }
        return s;
      },
    },
    'count-where': {
      label: 'Count Where', sqlKind: 'conditional', reAggregate: 'simple',
      compute: function (cells, rows, measure) {
        var where = measure && measure.where;
        if (!rows || !rows.length) return 0;
        var n = 0;
        for (var i = 0; i < rows.length; i++) if (_matchWhere(rows[i], where)) n++;
        return n;
      },
    },
    'cum-sum': {
      label: 'Cumulative Sum', sqlKind: 'window', reAggregate: 'none',
      compute: function (cells) { var s = 0; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) s += x; } return s; },
      cumulative: true,
    },
    'cum-count': {
      label: 'Cumulative Count', sqlKind: 'window', reAggregate: 'none',
      compute: function (cells) { return cells.length; },
      cumulative: true,
    },
    share: {
      label: 'Share of Total', sqlKind: 'twopass', reAggregate: 'none',
      compute: function (cells) { var s = 0; for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) s += x; } return s; },
      twopass: true, // post-process: divide by denominator
    },
    expr: {
      label: 'Custom Expression', sqlKind: 'expr', reAggregate: 'none',
      compute: function (cells, rows, measure) {
        try { return evalExpression(measure && measure._ast, rows || []); } catch (_) { return 0; }
      },
    },
  };

  // Backward-compat shim: old code uses AGG[key].fn(values) with plain values array
  const AGG = {
    count: { label: 'Count', fn: function (v) { return v.length; } },
    sum: { label: 'Sum', fn: function (v) { var s = 0; for (var i = 0; i < v.length; i++) { var x = parseFloat(v[i]); if (!isNaN(x)) s += x; } return s; } },
    avg: { label: 'Avg', fn: function (v) { var n = _toNums(v); return n.length ? n.reduce(function (a, b) { return a + b; }, 0) / n.length : 0; } },
    min: { label: 'Min', fn: function (v) { var n = _toNums(v); return n.length ? Math.min.apply(null, n) : ''; } },
    max: { label: 'Max', fn: function (v) { var n = _toNums(v); return n.length ? Math.max.apply(null, n) : ''; } },
  };

  // ===================== EXPRESSION PARSER (custom aggregations) =====================
  // Grammar:
  //   Expr    := Term (('+' | '-') Term)*
  //   Term    := Factor (('*' | '/') Factor)*
  //   Factor  := Number | AggCall | '(' Expr ')' | '-' Factor
  //   AggCall := ('SUM'|'AVG'|'COUNT'|'MIN'|'MAX'|'COUNT_DISTINCT') '(' Ident ')'
  //   Ident   := [A-Za-z_][A-Za-z0-9_ .]*
  // NO eval/Function. Agg functions whitelist only. Idents validated against allowed columns at eval time.
  var AGG_CALL_NAMES = { SUM: 1, AVG: 1, COUNT: 1, MIN: 1, MAX: 1, COUNT_DISTINCT: 1 };

  function tokenizeExpr(src) {
    var toks = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') { toks.push({ t: c }); i++; continue; }
      if (c >= '0' && c <= '9' || c === '.') {
        var j = i;
        while (j < n && (src[j] >= '0' && src[j] <= '9' || src[j] === '.')) j++;
        toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
        i = j; continue;
      }
      if (c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c === '_') {
        var k = i;
        while (k < n && (src[k] >= 'A' && src[k] <= 'Z' || src[k] >= 'a' && src[k] <= 'z' || src[k] >= '0' && src[k] <= '9' || src[k] === '_' || src[k] === ' ' || src[k] === '.')) k++;
        var word = src.slice(i, k).trim();
        toks.push({ t: 'ident', v: word });
        i = k; continue;
      }
      throw new Error('Unexpected character: ' + c);
    }
    return toks;
  }

  function parseExpr(src) {
    var toks = tokenizeExpr(src), p = 0;
    function peek() { return toks[p]; }
    function eat(t) { var tok = toks[p]; if (!tok || tok.t !== t) throw new Error('Expected ' + t + ', got ' + (tok ? tok.t : 'EOF')); p++; return tok; }
    function parseE() {
      var left = parseT();
      while (peek() && (peek().t === '+' || peek().t === '-')) { var op = toks[p++].t; var right = parseT(); left = { type: 'bin', op: op, l: left, r: right }; }
      return left;
    }
    function parseT() {
      var left = parseF();
      while (peek() && (peek().t === '*' || peek().t === '/')) { var op = toks[p++].t; var right = parseF(); left = { type: 'bin', op: op, l: left, r: right }; }
      return left;
    }
    function parseF() {
      var tok = peek();
      if (!tok) throw new Error('Unexpected end');
      if (tok.t === 'num') { p++; return { type: 'num', v: tok.v }; }
      if (tok.t === '-') { p++; return { type: 'neg', e: parseF() }; }
      if (tok.t === '(') { p++; var e = parseE(); eat(')'); return e; }
      if (tok.t === 'ident') {
        p++;
        var name = tok.v.trim();
        if (peek() && peek().t === '(') {
          // AggCall
          var upper = name.toUpperCase();
          if (!AGG_CALL_NAMES[upper]) throw new Error('Unknown aggregate: ' + name);
          p++; // eat '('
          var col = eat('ident').v.trim();
          eat(')');
          return { type: 'agg', fn: upper, col: col };
        }
        throw new Error('Bare identifier not allowed: ' + name);
      }
      throw new Error('Unexpected token: ' + tok.t);
    }
    var ast = parseE();
    if (p < toks.length) throw new Error('Unexpected trailing tokens');
    return ast;
  }

  function evalExpression(ast, rows) {
    if (!ast) return 0;
    function walk(n) {
      switch (n.type) {
        case 'num': return n.v;
        case 'neg': return -walk(n.e);
        case 'bin':
          var l = walk(n.l), r = walk(n.r);
          if (n.op === '+') return l + r;
          if (n.op === '-') return l - r;
          if (n.op === '*') return l * r;
          if (n.op === '/') return r === 0 ? 0 : l / r;
          return 0;
        case 'agg':
          var col = n.col, fn = n.fn, nums = [];
          if (fn === 'COUNT') return rows.length;
          if (fn === 'COUNT_DISTINCT') { var set = new Set(); for (var i = 0; i < rows.length; i++) set.add(rows[i][col]); return set.size; }
          for (var k = 0; k < rows.length; k++) { var x = parseFloat(rows[k][col]); if (!isNaN(x)) nums.push(x); }
          if (!nums.length) return 0;
          if (fn === 'SUM') return nums.reduce(function (a, b) { return a + b; }, 0);
          if (fn === 'AVG') return nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
          if (fn === 'MIN') return Math.min.apply(null, nums);
          if (fn === 'MAX') return Math.max.apply(null, nums);
          return 0;
      }
      return 0;
    }
    return walk(ast);
  }

  // Validate expression: parses + checks columns exist in allowedCols. Returns { ast, error }.
  function validateExpression(src, allowedCols) {
    try {
      var ast = parseExpr(String(src || ''));
      // Walk to check columns
      function check(n) {
        if (!n) return null;
        if (n.type === 'agg') {
          if (allowedCols && allowedCols.length && allowedCols.indexOf(n.col) === -1) {
            return 'Unknown column: ' + n.col;
          }
        }
        if (n.l) { var e1 = check(n.l); if (e1) return e1; }
        if (n.r) { var e2 = check(n.r); if (e2) return e2; }
        if (n.e) { var e3 = check(n.e); if (e3) return e3; }
        return null;
      }
      var err = check(ast);
      if (err) return { ast: null, error: err };
      return { ast: ast, error: null };
    } catch (e) {
      return { ast: null, error: e.message };
    }
  }

  // ===================== DATA EXTRACTION + CACHE =====================
  // Cache per component name — survives display:none (virtualized table renders 0 rows when hidden)
  var CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  var dataCache = {}; // componentName -> { columns: [], data: [], _ts: timestamp }
  var _componentIdMap = {}; // componentName -> component UUID (for multi-page unique identification)

  // Evict stale caches periodically
  setInterval(function () {
    var now = Date.now();
    for (var k in dataCache) { if (dataCache[k]._ts && now - dataCache[k]._ts > CACHE_TTL) delete dataCache[k]; }
    for (var k2 in _backendPivotCache) { if (_backendPivotCache[k2].timestamp && now - _backendPivotCache[k2].timestamp > CACHE_TTL) delete _backendPivotCache[k2]; }
  }, 60000);

  function getComponentName(tableEl) {
    var cy = tableEl.getAttribute('data-cy') || '';
    var m = cy.match(/^draggable-widget-(.+)$/);
    return m ? m[1] : null;
  }

  // Get component UUID from React fiber (for unique identification across pages)
  function getComponentId(tableEl) {
    if (!tableEl) return null;
    try {
      var fiberKey = Object.keys(tableEl).find(function (k) { return k.startsWith('__reactFiber'); });
      if (!fiberKey) return null;
      var fiber = tableEl[fiberKey];
      for (var i = 0; i < 20 && fiber; i++) {
        var props = fiber.memoizedProps || fiber.pendingProps;
        if (props) {
          // Direct UUID props
          if (props.id && typeof props.id === 'string' && props.id.match(/^[a-f0-9-]{36}$/)) return props.id;
          if (props.componentId && typeof props.componentId === 'string' && props.componentId.match(/^[a-f0-9-]{36}$/)) return props.componentId;
          // Nested component object
          if (props.component && props.component.id && typeof props.component.id === 'string') return props.component.id;
          // ToolJet widget props
          if (props.widgetId && typeof props.widgetId === 'string' && props.widgetId.match(/^[a-f0-9-]{36}$/)) return props.widgetId;
        }
        fiber = fiber.return;
      }
    } catch (_) {}
    // Fallback: try data attribute
    var cid = tableEl.getAttribute('data-component-id');
    if (cid) return cid;
    return null;
  }


  // Build a map of DOM column index → header display name (alias / "Column name")
  // Skips checkbox and action columns, matching <th> and <td> by their actual DOM index
  function buildHeaderMap(tableEl) {
    var headerMap = {}; // DOM index → display name
    var ths = tableEl.querySelectorAll('.jet-data-table thead th');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      // Skip checkbox column and action column
      if (th.querySelector('input[type="checkbox"]')) continue;
      if (th.classList.contains('table-action-header')) continue;
      var text = th.textContent.trim();
      if (text) headerMap[i] = text;
    }
    return headerMap;
  }

  function extractColumns(tableEl) {
    var headerMap = buildHeaderMap(tableEl);
    var cols = [];
    var keys = Object.keys(headerMap).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) {
      cols.push(headerMap[keys[i]]);
    }
    return cols;
  }

  function extractDataRaw(tableEl) {
    var headerMap = buildHeaderMap(tableEl);
    var columns = [];
    var sortedIdxs = Object.keys(headerMap).map(Number).sort(function (a, b) { return a - b; });
    for (var k = 0; k < sortedIdxs.length; k++) columns.push(headerMap[sortedIdxs[k]]);

    var data = [];
    var tbody = tableEl.querySelector('.jet-data-table tbody');
    if (!tbody) return { columns: columns, data: data };

    tbody.querySelectorAll('tr').forEach(function (tr) {
      var row = {};
      var tds = tr.querySelectorAll('td');
      // Match each <td> by its DOM index to the headerMap
      for (var i = 0; i < tds.length; i++) {
        if (headerMap[i] !== undefined) {
          row[headerMap[i]] = tds[i].textContent.trim();
        }
      }
      if (Object.keys(row).length > 0) data.push(row);
    });

    return { columns: columns, data: data };
  }

  // Extract data with cache fallback (handles virtualized table hidden by display:none)
  function extractData(tableEl) {
    var name = getComponentName(tableEl);

    // Try reading from DOM first
    var result = extractDataRaw(tableEl);

    // If DOM returned data, update cache
    if (result.data.length > 0) {
      if (name) { result._ts = Date.now(); dataCache[name] = result; }
      return result;
    }

    // DOM returned empty — table likely hidden (virtualization). Use cache.
    if (name && dataCache[name] && dataCache[name].data.length > 0) {
      return dataCache[name];
    }

    // Fallback: temporarily show dataArea, extract, then re-hide
    // (Returns empty result; caller must use extractDataAsync for the real data.)
    var dataArea = tableEl.querySelector('.jet-data-table');
    if (dataArea && dataArea.style.display === 'none') {
      dataArea.style.display = '';
      void dataArea.offsetHeight;
      return { columns: result.columns, data: [] };
    }

    return result;
  }

  // Async data extraction: show table briefly, extract after virtualizer renders, then re-hide
  function extractDataAsync(tableEl, callback) {
    var name = getComponentName(tableEl);

    // Check cache first
    if (name && dataCache[name] && dataCache[name].data.length > 0) {
      callback(dataCache[name]);
      return;
    }

    var dataArea = tableEl.querySelector('.jet-data-table');
    var wasHidden = dataArea && dataArea.style.display === 'none';

    // Temporarily show so virtualizer renders rows
    if (wasHidden) dataArea.style.display = '';

    requestAnimationFrame(function () {
      setTimeout(function () {
        var result = extractDataRaw(tableEl);
        if (result.data.length > 0 && name) {
          result._ts = Date.now(); dataCache[name] = result;
        }
        // Re-hide
        if (wasHidden && dataArea) dataArea.style.display = 'none';
        callback(result.data.length > 0 ? result : (name && dataCache[name]) ? dataCache[name] : result);
      }, 150);
    });
  }

  // ===================== PIVOT COMPUTATION =====================
  // tree[rk] = { cells: { ck: [{val, row}] }, values: [{val, row}], rows: [row] }
  // Cell entries store the aggregated value AND the source row, so aggregators
  // like sum-where / count-where / expr can access other fields of the row.
  function computePivot(data, config) {
    var rowFields = config.rowFields;
    var colFields = config.colFields;
    var measures = (config.measures && config.measures.length) ? config.measures : [{ field: config.valueField || '', aggregator: config.aggregator || 'count' }];
    var primaryField = measures[0].field || config.valueField || '';
    if (!data.length) return { tree: {}, colValues: [], rowKeys: [], rowFieldValues: {} };

    var colSet = new Set();
    var tree = {};
    var countTree = {}; // parallel to tree — stores _pivot_count for weighted avg
    var rowFieldValues = {}; // rowKey -> [val1, val2, ...]

    data.forEach(function (row) {
      var rowParts = rowFields.length ? rowFields.map(function (f) { return row[f] ?? '(empty)'; }) : ['(All)'];
      var rk = rowParts.join('\x00'); // use null byte as internal separator (never displayed)

      var colParts = colFields.length ? colFields.map(function (f) { return row[f] ?? '(empty)'; }) : ['(All)'];
      var ck = colParts.join('\x00');

      if (colFields.length) colSet.add(ck);
      if (!tree[rk]) { tree[rk] = { cells: {}, values: [], rows: [] }; rowFieldValues[rk] = rowParts; }
      if (!tree[rk].cells[ck]) tree[rk].cells[ck] = [];

      var val = primaryField ? row[primaryField] : (row['_count'] !== undefined ? row['_count'] : '1');
      var entry = { val: val, row: row };
      tree[rk].cells[ck].push(entry);
      tree[rk].values.push(entry);
      tree[rk].rows.push(row);

      // Track counts for weighted avg (backend pivot rows have _pivot_count)
      var cnt = row['_pivot_count'];
      if (cnt !== undefined) {
        if (!countTree[rk]) countTree[rk] = { cells: {}, counts: [] };
        if (!countTree[rk].cells[ck]) countTree[rk].cells[ck] = [];
        var cntNum = parseFloat(cnt) || 0;
        countTree[rk].cells[ck].push(cntNum);
        countTree[rk].counts.push(cntNum);
      }
    });

    // Natural sort: numeric parts compared as numbers, rest as strings
    function naturalCmp(a, b) {
      var pa = a.split('\x00'), pb = b.split('\x00');
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var va = pa[i] || '', vb = pb[i] || '';
        var na = parseFloat(va), nb = parseFloat(vb);
        var aIsNum = va !== '' && !isNaN(na) && isFinite(na) && String(na) === va.trim();
        var bIsNum = vb !== '' && !isNaN(nb) && isFinite(nb) && String(nb) === vb.trim();
        if (aIsNum && bIsNum) { if (na !== nb) return na - nb; }
        else { if (va < vb) return -1; if (va > vb) return 1; }
      }
      return 0;
    }

    return {
      tree: tree,
      countTree: countTree,
      colValues: Array.from(colSet).sort(naturalCmp),
      rowKeys: Object.keys(tree).sort(naturalCmp),
      rowFieldValues: rowFieldValues,
    };
  }

  // ===================== TITLE BAR =====================
  // Adjust table widget height to fit pivot content (for dynamic height)
  function adjustPivotHeight(tableEl, overlayEl) {
    requestAnimationFrame(function () {
      var pivotH = overlayEl.scrollHeight;
      if (pivotH > 0) {
        // Set min-height on the table widget container so dynamic height works
        var header = tableEl.querySelector('.table-card-header');
        var headerH = header ? header.offsetHeight : 0;
        var totalH = pivotH + headerH + 4;
        tableEl.style.minHeight = totalH + 'px';
        tableEl.style.height = 'auto';
        tableEl.style.overflow = 'visible';

        // Also adjust parent wrapper (react-grid-layout item) if it constrains height
        var parent = tableEl.parentElement;
        if (parent && parent.style && parent.style.height) {
          parent.style.height = totalH + 'px';
          parent.style.minHeight = totalH + 'px';
          parent.style.overflow = 'visible';
        }
      }
    });
  }

  function buildTitleHTML(config) {
    var title = (config.showTitle !== false && config.titleAlias) ? config.titleAlias : '';
    var dlIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    return '<div class="pivot-title-bar">' +
      (title ? '<span class="pivot-title-text">' + esc(title) + '</span>' : '<span></span>') +
      '<div class="pivot-toolbar">' +
      '<button class="pivot-download-btn" data-format="excel" title="Download Excel">' + dlIcon + ' Excel</button>' +
      '</div></div>';
  }

  // Error boundary: render error state with retry button (button class picked up by caller to bind)
  function buildErrorHTML(message, opts) {
    opts = opts || {};
    var showRetry = opts.retry !== false;
    var kind = opts.kind || 'error';
    var iconMap = {
      error: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
      warning: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      empty: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>',
    };
    var icon = iconMap[kind] || iconMap.error;
    return '<div class="pivot-error-state pivot-error-' + kind + '">' +
      '<div class="pivot-error-icon">' + icon + '</div>' +
      '<div class="pivot-error-msg">' + esc(message) + '</div>' +
      (showRetry ? '<button type="button" class="pivot-retry-btn">Retry</button>' : '') +
      '</div>';
  }

  // Render error in overlay + wire retry button
  function showErrorInOverlay(overlayEl, config, message, retryFn, kind) {
    overlayEl.innerHTML = buildTitleHTML(config) + buildErrorHTML(message, { kind: kind || 'error', retry: !!retryFn });
    if (retryFn) {
      var btn = overlayEl.querySelector('.pivot-retry-btn');
      if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); retryFn(); });
    }
  }

  // Build loading HTML (consistent across all call sites)
  function buildLoadingHTML(msg) {
    return '<div class="pivot-loading"><span class="pivot-spinner"></span><span>' + esc(msg || 'Loading...') + '</span></div>';
  }

  // ===================== DOWNLOAD =====================
  function downloadPivotExcel(overlayEl, config, filename) {
    var table = overlayEl.querySelector('.pivot-table');
    if (!table) return;
    var title = (config && config.titleAlias) ? config.titleAlias : '';
    var X = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); };

    // Count total columns
    var totalCols = 0;
    var fr = table.querySelector('tr');
    if (fr) { var fcs = fr.querySelectorAll('th, td'); for (var fi = 0; fi < fcs.length; fi++) totalCols += parseInt(fcs[fi].getAttribute('colspan') || '1', 10); }

    // Extract grid from DOM
    var grid = [], merges = [], rowIdx = 0;
    if (title) {
      grid.push([{ v: title, s: 0, _si: 0 }]);
      if (totalCols > 1) merges.push([0, 0, 0, totalCols - 1]);
      grid.push([]); rowIdx = 2;
    }
    // Grid map: tracks cells occupied by rowspan (key: "row,col" → true)
    var occupied = {};
    var trs = table.querySelectorAll('tr');
    for (var ri = 0; ri < trs.length; ri++) {
      var row = [];
      var cells = trs[ri].querySelectorAll('th, td');
      var ci = 0, colIdx = 0;
      for (ci = 0; ci < cells.length; ci++) {
        // Skip columns occupied by rowspan from previous rows
        while (occupied[rowIdx + ',' + colIdx]) { row.push({ v: '', t: 's', sk: '', a: null }); colIdx++; }

        var cell = cells[ci], text = cell.textContent.replace(/[▸▾]/g, '').trim();
        var colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
        var rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);
        var isH = cell.tagName === 'TH';
        var st = cell.getAttribute('style') || '';
        var bld = isH || st.indexOf('600') !== -1 || st.indexOf('bold') !== -1;
        var itl = st.indexOf('italic') !== -1;
        var align = st.match(/text-align:\s*(left|center|right)/);
        align = align ? align[1] : (isH ? 'center' : null);
        var num = parseFloat(text.replace(/,/g, ''));
        var isN = text && !isNaN(num) && isFinite(num) && /^-?[\d,.]+$/.test(text);
        var sk = (bld ? 'b' : '') + (itl ? 'i' : '');

        row.push({ v: isN ? num : text, t: isN ? 'n' : 's', sk: sk, a: align, h: isH });

        // Register merge and mark occupied cells for rowspan
        if (colspan > 1 || rowspan > 1) {
          merges.push([rowIdx, colIdx, rowIdx + rowspan - 1, colIdx + colspan - 1]);
          // Fill extra colspan cells in current row
          for (var cp = 1; cp < colspan; cp++) row.push({ v: '', t: 's', sk: sk, a: align, h: isH });
          // Mark cells occupied by rowspan for future rows
          if (rowspan > 1) {
            for (var rs = 1; rs < rowspan; rs++) {
              for (var cs = 0; cs < colspan; cs++) {
                occupied[(rowIdx + rs) + ',' + (colIdx + cs)] = true;
              }
            }
          }
        }
        colIdx += colspan;
      }
      // Fill remaining occupied columns at end of row
      while (occupied[rowIdx + ',' + colIdx]) { row.push({ v: '', t: 's', sk: '', a: null }); colIdx++; }
      grid.push(row); rowIdx++;
    }

    // Build XLSX
    // Shared strings
    var ss = [], ssMap = {};
    function si(str) { str = String(str); if (ssMap[str] !== undefined) return ssMap[str]; var i = ss.length; ss.push(str); ssMap[str] = i; return i; }

    // Styles: index 0 = default (plain), index 1 = title, index 2+ = data
    var styleList = [
      { b: false, i: false, a: null, sz: 11 },       // 0: default plain
      { b: true, i: false, a: 'center', sz: 14 },    // 1: title
    ];
    var TITLE_STYLE = 1;
    var styleMap = {};
    function getStyleIdx(sk, align) {
      var key = sk + '|' + (align || '');
      if (styleMap[key] !== undefined) return styleMap[key];
      var idx = styleList.length;
      styleList.push({ b: sk.indexOf('b') !== -1, i: sk.indexOf('i') !== -1, a: align, sz: 11 });
      styleMap[key] = idx;
      return idx;
    }
    // Pre-assign styles for all cells
    for (var gr = 0; gr < grid.length; gr++) {
      for (var gc = 0; gc < grid[gr].length; gc++) {
        var c = grid[gr][gc];
        if (gr === 0 && title) { c._si = TITLE_STYLE; continue; }
        c._si = getStyleIdx(c.sk, c.a);
      }
    }

    // Build styles.xml
    var fontsXml = '', fontMap = {}, fontList = [];
    // fontId=0 MUST be the default font (cellStyleXfs references it)
    fontList.push({ b: false, i: false, sz: 11 });
    fontMap['11'] = 0;
    function getFontIdx(b, i, sz) {
      var key = (b ? 'b' : '') + (i ? 'i' : '') + sz;
      if (fontMap[key] !== undefined) return fontMap[key];
      var idx = fontList.length;
      fontList.push({ b: b, i: i, sz: sz });
      fontMap[key] = idx;
      return idx;
    }
    // Build xf entries
    var xfEntries = [];
    for (var si2 = 0; si2 < styleList.length; si2++) {
      var s = styleList[si2];
      var fi2 = getFontIdx(s.b, s.i, s.sz);
      xfEntries.push({ fontId: fi2, align: s.a });
    }

    fontsXml = '<fonts count="' + fontList.length + '">';
    for (var fl = 0; fl < fontList.length; fl++) {
      fontsXml += '<font>';
      if (fontList[fl].b) fontsXml += '<b/>';
      if (fontList[fl].i) fontsXml += '<i/>';
      fontsXml += '<sz val="' + fontList[fl].sz + '"/><name val="Arial"/></font>';
    }
    fontsXml += '</fonts>';

    // xf index 0 = default plain, index 1 = title, index 2+ = data
    var xfXml = '<cellXfs count="' + xfEntries.length + '">';
    for (var xi = 0; xi < xfEntries.length; xi++) {
      var xf = xfEntries[xi];
      if (xi === 0) {
        // Default plain style (required as index 0)
        xfXml += '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      } else if (xi === 1) {
        // Title: bold 14pt, centered, no border
        xfXml += '<xf numFmtId="0" fontId="' + xf.fontId + '" fillId="0" borderId="0" xfId="0"' +
          ' applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>';
      } else {
        // Data cells: with border
        xfXml += '<xf numFmtId="0" fontId="' + xf.fontId + '" fillId="0" borderId="1" xfId="0"' +
          ' applyFont="1" applyBorder="1"';
        if (xf.align) {
          xfXml += ' applyAlignment="1"><alignment horizontal="' + xf.align + '"/></xf>';
        } else {
          xfXml += '/>';
        }
      }
    }
    xfXml += '</cellXfs>';

    var bordersXml = '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
      '<left style="thin"><color auto="1"/></left>' +
      '<right style="thin"><color auto="1"/></right>' +
      '<top style="thin"><color auto="1"/></top>' +
      '<bottom style="thin"><color auto="1"/></bottom>' +
      '<diagonal/></border></borders>';

    var stylesFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      fontsXml +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      bordersXml +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      xfXml + '</styleSheet>';

    // Sheet XML
    var colRef = function (c) { var s = ''; c++; while (c > 0) { s = String.fromCharCode(((c - 1) % 26) + 65) + s; c = Math.floor((c - 1) / 26); } return s; };
    var sheetRows = '';
    for (var r = 0; r < grid.length; r++) {
      var row2 = grid[r];
      if (!row2.length) { sheetRows += '<row r="' + (r + 1) + '"/>'; continue; }
      sheetRows += '<row r="' + (r + 1) + '">';
      for (var c2 = 0; c2 < row2.length; c2++) {
        var cl = row2[c2], ref = colRef(c2) + (r + 1), sIdx = cl._si || 0;
        if (cl.t === 'n' && cl.v !== '' && cl.v !== undefined) {
          sheetRows += '<c r="' + ref + '" s="' + sIdx + '"><v>' + cl.v + '</v></c>';
        } else if (cl.v) {
          sheetRows += '<c r="' + ref + '" s="' + sIdx + '" t="s"><v>' + si(cl.v) + '</v></c>';
        } else {
          sheetRows += '<c r="' + ref + '" s="' + sIdx + '"/>';
        }
      }
      sheetRows += '</row>';
    }
    var mergeXml = '';
    if (merges.length) {
      mergeXml = '<mergeCells count="' + merges.length + '">';
      for (var mi = 0; mi < merges.length; mi++) { var m = merges[mi]; mergeXml += '<mergeCell ref="' + colRef(m[1]) + (m[0] + 1) + ':' + colRef(m[3]) + (m[2] + 1) + '"/>'; }
      mergeXml += '</mergeCells>';
    }
    // Calculate column widths (autofit based on content length)
    var colWidths = [];
    for (var wr = 0; wr < grid.length; wr++) {
      for (var wc = 0; wc < grid[wr].length; wc++) {
        var cellVal = String(grid[wr][wc].v || '');
        var len = cellVal.length;
        // Approximate: 1 char ≈ 1.2 width units, min 8, max 50
        var w = Math.max(len * 1.2 + 2, 8);
        if (grid[wr][wc].sz === 14) w = Math.max(w, 10); // title font wider
        if (!colWidths[wc] || w > colWidths[wc]) colWidths[wc] = w;
      }
    }
    var colsXml = '<cols>';
    for (var ci3 = 0; ci3 < colWidths.length; ci3++) {
      var cw = Math.min(colWidths[ci3] || 10, 50);
      colsXml += '<col min="' + (ci3 + 1) + '" max="' + (ci3 + 1) + '" width="' + cw.toFixed(1) + '" bestFit="1" customWidth="1"/>';
    }
    colsXml += '</cols>';

    var sheetFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + colsXml + '<sheetData>' + sheetRows + '</sheetData>' + mergeXml + '</worksheet>';


    var ssFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + ss.length + '" uniqueCount="' + ss.length + '">';
    for (var s3 = 0; s3 < ss.length; s3++) ssFile += '<si><t>' + X(ss[s3]) + '</t></si>';
    ssFile += '</sst>';

    var wbFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + X(filename || 'Pivot').substring(0, 31) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
    var ctFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
    var relsFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    var wbRelsFile = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';

    var blob = _buildZip([
      ['[Content_Types].xml', ctFile], ['_rels/.rels', relsFile], ['xl/workbook.xml', wbFile],
      ['xl/_rels/workbook.xml.rels', wbRelsFile], ['xl/worksheets/sheet1.xml', sheetFile],
      ['xl/styles.xml', stylesFile], ['xl/sharedStrings.xml', ssFile],
    ]);
    triggerDownload(blob, (filename || 'pivot_table') + '.xlsx');
  }

  // Minimal ZIP builder (STORE, no compression)
  function _buildZip(files) {
    var enc = new TextEncoder(), parts = [], cd = [], off = 0;
    for (var i = 0; i < files.length; i++) {
      var n = enc.encode(files[i][0]), d = enc.encode(files[i][1]), cr = _crc32(d);
      var lh = new Uint8Array(30 + n.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint16(8, 0, true); lv.setUint32(14, cr, true);
      lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true);
      lv.setUint16(26, n.length, true); lh.set(n, 30);
      var ce = new Uint8Array(46 + n.length), cv = new DataView(ce.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, cr, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true);
      cv.setUint16(28, n.length, true); cv.setUint32(42, off, true); ce.set(n, 46);
      parts.push(lh, d); cd.push(ce); off += lh.length + d.length;
    }
    var cdOff = off, cdSz = 0;
    for (var j = 0; j < cd.length; j++) { parts.push(cd[j]); cdSz += cd[j].length; }
    var eo = new Uint8Array(22), ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true); ev.setUint32(12, cdSz, true); ev.setUint32(16, cdOff, true);
    parts.push(eo);
    return new Blob(parts, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function _crc32(b) {
    var t = _crc32.t; if (!t) { t = _crc32.t = new Uint32Array(256); for (var i = 0; i < 256; i++) { var c = i; for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; } }
    var r = 0xFFFFFFFF; for (var k = 0; k < b.length; k++) r = t[(r ^ b[k]) & 0xFF] ^ (r >>> 8); return (r ^ 0xFFFFFFFF) >>> 0;
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 100);
  }

  // Bind download buttons on any pivot overlay
  function bindDownloadButtons(overlayEl, componentName) {
    var cfg = (componentName && typeof configCache !== 'undefined' && configCache[componentName]) ||
              (componentName && typeof viewerConfigs !== 'undefined' && viewerConfigs[componentName]) ||
              loadConfigLocal(componentName) || {};
    var btns = overlayEl.querySelectorAll('.pivot-download-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        var fname = (cfg.titleAlias || componentName || 'pivot_table');
        downloadPivotExcel(overlayEl, cfg, fname);
      });
    }
  }


  // Collapse/expand feature removed
  function bindCollapseToggles() { /* no-op */ }

  // Bind sort headers — click cycles desc → asc → none, re-renders pivot
  function bindSortHeaders(overlayEl, componentName, data, config, tableEl, serverTotal) {
    var ths = overlayEl.querySelectorAll('th.pivot-sortable');
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener('click', function (e) {
        e.stopPropagation();
        var key = this.getAttribute('data-sort-key');
        if (!key) return;
        var curKey = config.sort && config.sort.key;
        var curDir = config.sort && config.sort.direction;
        var newDir;
        if (curKey !== key) newDir = 'desc';
        else if (curDir === 'desc') newDir = 'asc';
        else newDir = null;
        config.sort = newDir ? { key: key, direction: newDir } : null;

        // Persist to config cache so editor + future loads see it
        try {
          if (typeof setConfig === 'function') setConfig(componentName, config);
          if (typeof configCache !== 'undefined' && configCache[componentName]) configCache[componentName].sort = config.sort;
          if (typeof viewerConfigs !== 'undefined' && viewerConfigs[componentName]) viewerConfigs[componentName].sort = config.sort;
        } catch (_) {}

        // Re-render
        setPivotPage(componentName, 0);
        var self = this;
        if (config.backendPivot && (config.pageSize || 0) > 0) {
          overlayEl.innerHTML = buildTitleHTML(config) + buildLoadingHTML('Sorting...');
          executePivotAsync(componentName, config, function (err, rows, total, grandTotals, subtotals) {
            if (err) {
              showErrorInOverlay(overlayEl, config, err.message || 'Sort failed', function () { self.click ? self.click() : null; });
              return;
            }
            var pData = reshapeBackendRows(rows, config);
            pData._isBackend = true;
            overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(pData, config, componentName, total, grandTotals, subtotals);
            overlayEl._pivotData = pData; overlayEl._pivotServerTotal = total; overlayEl._pivotServerGrandTotals = grandTotals;
            bindDownloadButtons(overlayEl, componentName);
            bindPaginationButtons(overlayEl, componentName, pData, config, tableEl, total);
            bindSortHeaders(overlayEl, componentName, pData, config, tableEl, total);
            if (tableEl) adjustPivotHeight(tableEl, overlayEl);
          }, 0, config.pageSize || 0);
        } else {
          overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, componentName, serverTotal, overlayEl._pivotServerGrandTotals, overlayEl._pivotServerSubtotals);
          bindDownloadButtons(overlayEl, componentName);
          bindPaginationButtons(overlayEl, componentName, data, config, tableEl, serverTotal);
          bindSortHeaders(overlayEl, componentName, data, config, tableEl, serverTotal);
          if (tableEl) adjustPivotHeight(tableEl, overlayEl);
        }
      });
    }
  }

  // Bind pagination buttons — re-renders pivot on page change
  // serverTotal: if not null, use backend pagination (re-fetch from API)
  function bindPaginationButtons(overlayEl, componentName, data, config, tableEl, serverTotal) {
    var btns = overlayEl.querySelectorAll('.pivot-page-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        if (this.disabled) return;
        var page = parseInt(this.getAttribute('data-page'), 10);
        if (isNaN(page) || page < 0) return;
        setPivotPage(componentName, page);

        var pageSize = config.pageSize || 0;

        if (config.backendPivot && pageSize > 0) {
          // Backend paging: re-fetch from API with new page
          var clickedBtn = this;
          overlayEl.innerHTML = buildTitleHTML(config) + buildLoadingHTML('Loading page ' + (page + 1) + '...');
          executePivotAsync(componentName, config, function (err, rows, total, grandTotals, subtotals) {
            if (err) {
              showErrorInOverlay(overlayEl, config, err.message || ('Failed to load page ' + (page + 1)), function () { clickedBtn.click && clickedBtn.click(); });
              return;
            }
            var pData = reshapeBackendRows(rows, config);
            pData._isBackend = true;
            overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(pData, config, componentName, total, grandTotals, subtotals);
            overlayEl._pivotData = pData; overlayEl._pivotServerTotal = total; overlayEl._pivotServerGrandTotals = grandTotals;
            bindDownloadButtons(overlayEl, componentName);
            bindPaginationButtons(overlayEl, componentName, pData, config, tableEl, total);
            bindCollapseToggles(overlayEl, componentName, pData, config, tableEl, total, grandTotals);
            bindSortHeaders(overlayEl, componentName, pData, config, tableEl, total);
            if (tableEl) adjustPivotHeight(tableEl, overlayEl);
            var scroll = overlayEl.querySelector('.pivot-result-scroll');
            if (scroll) scroll.scrollTop = 0;
          }, page, pageSize);
        } else {
          // Frontend paging: re-render from local data
          overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, componentName);
          overlayEl._pivotData = data;
          bindDownloadButtons(overlayEl, componentName);
          bindPaginationButtons(overlayEl, componentName, data, config, tableEl);
          bindCollapseToggles(overlayEl, componentName, data, config, tableEl);
          bindSortHeaders(overlayEl, componentName, data, config, tableEl);
          if (tableEl) adjustPivotHeight(tableEl, overlayEl);
          var scroll = overlayEl.querySelector('.pivot-result-scroll');
          if (scroll) scroll.scrollTop = 0;
        }
      });
    }
  }

  // ===================== RENDER PIVOT HTML =====================
  // serverTotal: if provided, data is already paginated by backend (skip local slicing)
  // serverGrandTotals: if provided, use for grand total row instead of computing from page data
  // serverSubtotals: if provided, use for subtotal rows (per level)
  function renderPivotHTML(data, config, componentName, serverTotal, serverGrandTotals, serverSubtotals) {
    normalizeConfig(config);
    var result = computePivot(data, config);
    var tree = result.tree;
    var countTree = result.countTree || {};
    var colValues = result.colValues;
    var rowKeys = result.rowKeys;
    var rowFieldValues = result.rowFieldValues;
    var isBackend = serverTotal != null || data._isBackend;
    var measures = config.measures;

    // Backend pivot returns pre-aggregated values.
    // For count: sum the pre-counted values. For others: aggregator stays the same but applied to partials.
    var hasCountTree = Object.keys(countTree).length > 0;

    // Rebuild cells[] for a specific measure. Priority:
    //   1. Backend multi-measure: row['__m_' + measure.id]
    //   2. Legacy: row[measure.field]
    //   3. Original cells (primary measure fallback)
    function cellsForMeasure(cells, rows, measure) {
      if (!measure) return cells || [];
      if (!rows || !rows.length) return cells || [];
      var synthKey = '__m_' + measure.id;
      var hasSynth = rows[0] && rows[0][synthKey] !== undefined;
      if (!hasSynth && !measure.field) return cells || [];
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var v = hasSynth ? rows[i][synthKey] : rows[i][measure.field];
        out.push({ val: v, row: rows[i] });
      }
      return out;
    }

    // Per-measure effective compute (handles backend re-aggregation quirks)
    function measureCompute(measure, cells, rows) {
      var reg = AGG_REGISTRY[measure.aggregator];
      if (!reg) return '';
      var mCells = cellsForMeasure(cells, rows, measure);
      if (isBackend) {
        // Backend pivot: values in mCells are ALREADY aggregated (e.g. SUM(CASE WHEN ...)).
        // Frontend must re-aggregate partials, not re-run the aggregator.
        var agg = measure.aggregator;
        // Sum-style (sum, count, sum-where, count-where, cum-sum, cum-count, share): sum partials
        if (agg === 'count' || agg === 'sum' || agg === 'sum-where' || agg === 'count-where' ||
            agg === 'cum-sum' || agg === 'cum-count' || agg === 'share') {
          var s = 0;
          for (var i = 0; i < mCells.length; i++) { var x = parseFloat(mCells[i].val); if (!isNaN(x)) s += x; }
          return s;
        }
        // Min / Max: take min/max of partials
        if (agg === 'min' || agg === 'max') {
          var nums = [];
          for (var j = 0; j < mCells.length; j++) { var n = parseFloat(mCells[j].val); if (!isNaN(n)) nums.push(n); }
          if (!nums.length) return '';
          return agg === 'min' ? Math.min.apply(null, nums) : Math.max.apply(null, nums);
        }
        // Avg: weighted avg handled by caller (computeCell's useWeighted branch); fall back to average of partials
        if (agg === 'avg') {
          var a = 0, c = 0;
          for (var k = 0; k < mCells.length; k++) { var v = parseFloat(mCells[k].val); if (!isNaN(v)) { a += v; c++; } }
          return c ? a / c : 0;
        }
        // expr: for backend, the SQL returned a pre-computed value per cell. Just sum partials.
        if (agg === 'expr') {
          var e = 0;
          for (var m = 0; m < mCells.length; m++) { var ev = parseFloat(mCells[m].val); if (!isNaN(ev)) e += ev; }
          return e;
        }
        // distinct / median / percentile / stddev / variance: backend returned the single aggregated value
        // per (rowKey, colKey). If exactly 1 partial, return it; else we can't correctly re-aggregate
        // (those aggregators are in NON_REAGGREGABLE). Return the single value when possible.
        if (mCells.length === 1) {
          var only = parseFloat(mCells[0].val);
          return isNaN(only) ? (mCells[0].val || '') : only;
        }
        // Multiple partials for non-reaggregable agg: best-effort fallback = average
        var fa = 0, fc = 0;
        for (var q = 0; q < mCells.length; q++) { var fv = parseFloat(mCells[q].val); if (!isNaN(fv)) { fa += fv; fc++; } }
        return fc ? fa / fc : 0;
      }
      // Frontend pivot: run the aggregator over source rows
      return reg.compute(mCells, rows || [], measure);
    }

    // Weighted avg for backend pre-aggregated rows (uses _pivot_count)
    function weightedAvgCells(cells, countsList) {
      if (!cells || !cells.length) return 0;
      if (!countsList || countsList.length !== cells.length) {
        // Fallback: plain avg
        var n = 0, s = 0;
        for (var i = 0; i < cells.length; i++) { var x = parseFloat(cells[i].val); if (!isNaN(x)) { s += x; n++; } }
        return n ? s / n : 0;
      }
      var sp = 0, sc = 0;
      for (var j = 0; j < cells.length; j++) { var v = parseFloat(cells[j].val) || 0; var c = parseFloat(countsList[j]) || 0; sp += v * c; sc += c; }
      return sc > 0 ? sp / sc : 0;
    }

    // Store component name for pagination state lookup
    config._componentName = componentName || config._componentName || '';
    var _serverTotal = serverTotal;

    if (rowKeys.length === 0) {
      return '<div class="pivot-empty">No data to pivot. Ensure the table has loaded data.</div>';
    }

    var rowFields = config.rowFields;
    var colFields = config.colFields;
    var showCols = colValues.length > 0;
    // Row Total only makes sense when columns exist (sum across columns).
    // With no col fields, each row has just one cell per measure — total = cell value (redundant).
    var showRowTotal = config.showRowTotal !== false && showCols;
    var rowTotalLabel = config.rowTotalLabel || 'Total';
    var showGrandTotal = config.showGrandTotal !== false;
    var grandTotalLabel = config.grandTotalLabel || 'Grand Total';
    var showSubtotal = config.showSubtotal && rowFields.length > 1;
    var subtotalLabel = config.subtotalLabel || '{group} Subtotal';
    var numRowCols = rowFields.length || 1;
    var numColFields = colFields.length || 0;
    var numMeasures = measures.length;
    var isMulti = numMeasures > 1;

    // Alignment styles
    var aRow = config.alignRowFields || 'left';
    var aVal = config.alignColValues || 'right';
    var aRT = config.alignRowTotal || 'right';
    var aGT = config.alignGrandTotal || 'right';
    var aST = config.alignSubtotal || 'right';
    // Text styles
    var sRow = config.styleRowFields || '';
    var sVal = config.styleColValues || '';
    var sRT = config.styleRowTotal || '';
    var sGT = config.styleGrandTotal || '';
    var sST = config.styleSubtotal || '';
    // Empty cell display
    var emptyVal = config.emptyValue !== undefined ? config.emptyValue : '0';

    // Collapse feature removed

    // Number formatter: supports per-measure decimals/prefix/suffix/format
    function fmtVal(v, measure) {
      if (v === '' || v === null || v === undefined) return esc(emptyVal);
      var n = parseFloat(v);
      if (isNaN(n)) return esc(String(v));
      // Per-measure decimal places override global
      var mDp = measure && (measure.decimalPlaces !== undefined && measure.decimalPlaces !== '' && measure.decimalPlaces !== null) ? measure.decimalPlaces : config.decimalPlaces;
      var nf = measure && measure.numberFormat;
      // For percent: multiply by 100 FIRST, then apply decimals (0.2121 → 21.21, not 0.21 → 21.00)
      if (nf === 'percent') n = n * 100;
      var out;
      if (mDp === 'auto' || mDp === undefined || mDp === null || mDp === '') {
        // Auto: for percent give 2 decimals by default (so 21.21% not 21.2121333%)
        if (nf === 'percent') out = n.toFixed(2);
        else out = String(n);
      } else {
        out = n.toFixed(parseInt(mDp, 10));
      }
      if (nf === 'percent') {
        out = out + '%';
      } else if (nf === 'comma' || nf === 'currency') {
        var parts = out.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        out = parts.join('.');
      }
      if (measure && measure.prefix) out = measure.prefix + out;
      if (measure && measure.suffix) out = out + measure.suffix;
      return esc(out);
    }
    // Back-compat fmtNum (no measure)
    function fmtNum(v) { return fmtVal(v, null); }

    // Build inline style from alignment + text style string (+ optional extra CSS, e.g. conditional formatting)
    function sf(align, style, extraCss) {
      var css = 'text-align:' + align;
      css += ';font-weight:' + (style.indexOf('bold') !== -1 ? '600' : 'normal');
      css += ';font-style:' + (style.indexOf('italic') !== -1 ? 'italic' : 'normal');
      css += ';text-decoration:' + (style.indexOf('underline') !== -1 ? 'underline' : 'none');
      if (extraCss) css += extraCss;
      return ' style="' + css + '"';
    }

    // ===================== CONDITIONAL FORMATTING =====================
    var cfRules = Array.isArray(config.conditionalFormats) ? config.conditionalFormats : [];
    // Per-gradient-rule stats: ruleId → { min, max }
    // Computed lazily on first access via _computeGradientStats()
    var _gradientStats = null;
    function _hexToRgb(hex) {
      var h = String(hex || '').replace('#', '');
      if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
      if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 255, b: 255 }; // fallback white for invalid hex
      var n = parseInt(h, 16);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    function _interpolateColor(c1, c2, t) {
      var a = _hexToRgb(c1), b = _hexToRgb(c2);
      t = Math.max(0, Math.min(1, t));
      var r = Math.round(a.r + (b.r - a.r) * t);
      var g = Math.round(a.g + (b.g - a.g) * t);
      var bl = Math.round(a.b + (b.b - a.b) * t);
      return 'rgb(' + r + ',' + g + ',' + bl + ')';
    }
    function _computeGradientStats() {
      if (_gradientStats) return _gradientStats;
      _gradientStats = {};
      for (var ri = 0; ri < cfRules.length; ri++) {
        var rule = cfRules[ri];
        if (rule.type !== 'gradient') continue;
        var mIdx = -1;
        for (var mi = 0; mi < measures.length; mi++) { if (measures[mi].id === rule.measureId) { mIdx = mi; break; } }
        if (mIdx < 0) continue;
        var measure = measures[mIdx];
        var minV = Infinity, maxV = -Infinity;
        // Walk data cells only (exclude totals to avoid skewed range)
        for (var rki = 0; rki < rowKeys.length; rki++) {
          var rd = tree[rowKeys[rki]];
          if (!rd) continue;
          if (showCols) {
            for (var cvi = 0; cvi < colValues.length; cvi++) {
              var cs = rd.cells[colValues[cvi]] || [];
              var rs = cs.map(function (c) { return c.row; });
              var vv = computeCell(cs, rs, measure, rowKeys[rki], colValues[cvi]);
              var nn = parseFloat(vv);
              if (!isNaN(nn) && isFinite(nn)) { if (nn < minV) minV = nn; if (nn > maxV) maxV = nn; }
            }
          } else {
            var vv2 = computeCell(rd.values || [], rd.rows || [], measure, rowKeys[rki], '(All)');
            var nn2 = parseFloat(vv2);
            if (!isNaN(nn2) && isFinite(nn2)) { if (nn2 < minV) minV = nn2; if (nn2 > maxV) maxV = nn2; }
          }
        }
        _gradientStats[rule.id] = { min: isFinite(minV) ? minV : 0, max: isFinite(maxV) ? maxV : 0 };
      }
      return _gradientStats;
    }
    function _ruleMatchesMeasure(rule, measure) {
      return rule.measureId === 'all' || rule.measureId === measure.id;
    }
    function _thresholdMatches(rule, n) {
      if (isNaN(n)) return false;
      var v1 = parseFloat(rule.value1), v2 = parseFloat(rule.value2);
      switch (rule.operator) {
        case '>': return n > v1;
        case '<': return n < v1;
        case '>=': return n >= v1;
        case '<=': return n <= v1;
        case '=': return n === v1;
        case 'between': return n >= Math.min(v1, v2) && n <= Math.max(v1, v2);
      }
      return false;
    }
    function cfStyle(val, measure, isTotal) {
      if (!cfRules.length || !measure) return '';
      var n = parseFloat(val);
      for (var i = 0; i < cfRules.length; i++) {
        var rule = cfRules[i];
        if (!_ruleMatchesMeasure(rule, measure)) continue;
        if (isTotal && !rule.applyToTotals) continue;
        if (rule.type === 'threshold') {
          if (_thresholdMatches(rule, n)) {
            var css = ';background-color:' + rule.bgColor;
            if (rule.textColor) css += ';color:' + rule.textColor;
            return css;
          }
        } else if (rule.type === 'gradient') {
          if (isNaN(n)) continue;
          var stats = _computeGradientStats()[rule.id];
          if (!stats) continue;
          var range = stats.max - stats.min;
          var t = range > 0 ? (n - stats.min) / range : 0.5;
          return ';background-color:' + _interpolateColor(rule.minColor, rule.maxColor, t);
        }
      }
      return '';
    }

    // Split column key back to individual parts
    function colParts(ck) {
      return ck.split('\x00');
    }

    // Helper: get per-cell value for a measure using its own .field
    // Handles both backend (synthetic __m_<id>) and frontend (row[field]) cases.
    function _measureCellVal(row, measure) {
      var synthKey = '__m_' + measure.id;
      if (row[synthKey] !== undefined) return row[synthKey];
      if (measure.field) return row[measure.field];
      return null;
    }

    // Cumulative aggs — pre-compute running totals per (col, measure) across row order
    // Only for FRONTEND pivot. Backend already computed the running total via window function.
    var cumulativeCache = {};
    for (var mi = 0; mi < measures.length; mi++) {
      var mm = measures[mi];
      var reg = AGG_REGISTRY[mm.aggregator];
      if (reg && reg.cumulative && !isBackend) {
        cumulativeCache[mm.id] = {};
        var cols = showCols ? colValues : [Object.keys(tree[rowKeys[0]] ? tree[rowKeys[0]].cells : {})[0]];
        for (var cii = 0; cii < cols.length; cii++) {
          var ck = cols[cii];
          var acc = 0;
          cumulativeCache[mm.id][ck] = {};
          for (var rri = 0; rri < rowKeys.length; rri++) {
            var rk = rowKeys[rri];
            var cls = (tree[rk] && tree[rk].cells[ck]) || [];
            if (mm.aggregator === 'cum-count') acc += cls.length;
            else {
              for (var cj = 0; cj < cls.length; cj++) {
                var xv = parseFloat(_measureCellVal(cls[cj].row, mm));
                if (!isNaN(xv)) acc += xv;
              }
            }
            cumulativeCache[mm.id][ck][rk] = acc;
          }
        }
      }
    }

    // Grand total cache for 'share' denominator — uses measure's own .field
    var shareDenominator = {};
    for (var smi = 0; smi < measures.length; smi++) {
      var sm = measures[smi];
      if (sm.aggregator === 'share') {
        var tot = 0;
        for (var srk = 0; srk < rowKeys.length; srk++) {
          var sv = tree[rowKeys[srk]].rows || [];
          for (var svk = 0; svk < sv.length; svk++) {
            var svx = parseFloat(_measureCellVal(sv[svk], sm));
            if (!isNaN(svx)) tot += svx;
          }
        }
        shareDenominator[sm.id] = tot;
      }
    }

    // Compute a single cell value for a given set of cell entries + rows, applying weighted avg / cumulative / share
    function computeCell(cells, rows, measure, rk, ck) {
      if (!measure) return '';
      var reg = AGG_REGISTRY[measure.aggregator];
      if (!reg) return '';
      // Weighted avg for backend pre-aggregated — must use per-measure cells (not primary)
      var useWeighted = isBackend && measure.aggregator === 'avg' && hasCountTree && measure.field === (config.valueField || measures[0].field);
      if (useWeighted && rk !== undefined && ck !== undefined && countTree[rk] && countTree[rk].cells[ck]) {
        return weightedAvgCells(cellsForMeasure(cells, rows, measure), countTree[rk].cells[ck]);
      }
      // Cumulative: use cache
      if (reg.cumulative && rk !== undefined && ck !== undefined && cumulativeCache[measure.id] && cumulativeCache[measure.id][ck]) {
        return cumulativeCache[measure.id][ck][rk] || 0;
      }
      var v = measureCompute(measure, cells, rows);
      // Share: divide by denominator
      if (measure.aggregator === 'share') {
        var d = shareDenominator[measure.id] || 0;
        return d > 0 ? (v / d) : 0;
      }
      return v;
    }

    // Render ONE cell (<td>) for a given measure. Optional classes added.
    function renderCell(cells, rows, measure, align, style, extraClass, rk, ck) {
      var v = computeCell(cells || [], rows || [], measure, rk, ck);
      var text = (cells && cells.length) || measure.aggregator === 'count' || measure.aggregator === 'count-where' || measure.aggregator === 'expr' ? fmtVal(v, measure) : esc(emptyVal);
      var isTotal = !!(extraClass && extraClass.indexOf('pivot-total-cell') !== -1);
      var cfCss = cfStyle(v, measure, isTotal);
      return '<td class="pivot-cell' + (extraClass ? ' ' + extraClass : '') + '"' + sf(align, style, cfCss) + '>' + text + '</td>';
    }

    // ===================== SORT =====================
    var sortKey = (config.sort && config.sort.key) || null;
    var sortDir = (config.sort && config.sort.direction) || null;
    function rowSortVal(rk) {
      if (!sortKey) return 0;
      if (sortKey.indexOf('row:') === 0) {
        var idx = parseInt(sortKey.slice(4), 10);
        if (isNaN(idx) || idx < 0 || idx >= (rowFields || []).length) return 0;
        var parts = rowFieldValues[rk] || [];
        return parts[idx] !== undefined ? parts[idx] : '';
      }
      if (sortKey.indexOf('col:') === 0) {
        var rest = sortKey.slice(4);
        var sep = rest.lastIndexOf('|');
        if (sep < 0) return 0;
        var cv = rest.slice(0, sep);
        var mi = parseInt(rest.slice(sep + 1), 10);
        if (isNaN(mi) || mi < 0 || mi >= measures.length) return 0;
        var rd = tree[rk]; if (!rd) return 0;
        var cs = rd.cells[cv] || [];
        return parseFloat(computeCell(cs, cs.map(function (c) { return c.row; }), measures[mi], rk, cv)) || 0;
      }
      if (sortKey.indexOf('rowTotal:') === 0) {
        var mi2 = parseInt(sortKey.slice('rowTotal:'.length), 10);
        if (isNaN(mi2) || mi2 < 0 || mi2 >= measures.length) return 0;
        var rd2 = tree[rk]; if (!rd2) return 0;
        return parseFloat(computeCell(rd2.values || [], rd2.rows || [], measures[mi2], rk, null)) || 0;
      }
      return 0;
    }
    function cmpSort(a, b) {
      var sign = sortDir === 'desc' ? -1 : 1;
      if (typeof a === 'string' && typeof b === 'string') return sign * a.localeCompare(b);
      var na = parseFloat(a), nb = parseFloat(b);
      if (isNaN(na)) na = typeof a === 'number' ? a : -Infinity;
      if (isNaN(nb)) nb = typeof b === 'number' ? b : -Infinity;
      return sign * (na - nb);
    }
    var _rowSortCache = {};
    if (sortKey && sortDir) {
      for (var _rki = 0; _rki < rowKeys.length; _rki++) {
        _rowSortCache[rowKeys[_rki]] = rowSortVal(rowKeys[_rki]);
      }
      rowKeys = rowKeys.slice().sort(function (a, b) {
        return cmpSort(_rowSortCache[a], _rowSortCache[b]);
      });
    }
    // Recursive: sort group tree node.order by aggregate of descendants
    function sortTreeNode(node, depth) {
      if (!sortKey || !sortDir || !node.order || !node.order.length) return;
      var aggMap = {};
      for (var oi = 0; oi < node.order.length; oi++) {
        var gVal = node.order[oi];
        var child = node.children[gVal];
        if (!child) continue;
        var agg;
        if (sortKey.indexOf('row:') === 0) {
          var lvl = parseInt(sortKey.slice(4), 10);
          if (lvl === depth) {
            agg = gVal;
          } else {
            agg = child.keys.length ? _rowSortCache[child.keys[0]] : '';
          }
        } else {
          // col:/rowTotal: → sum of descendant leaf values
          var s = 0;
          for (var ki = 0; ki < child.keys.length; ki++) {
            var v = parseFloat(_rowSortCache[child.keys[ki]]);
            if (!isNaN(v)) s += v;
          }
          agg = s;
        }
        aggMap[gVal] = agg;
      }
      node.order.sort(function (a, b) { return cmpSort(aggMap[a], aggMap[b]); });
      for (var oi2 = 0; oi2 < node.order.length; oi2++) {
        sortTreeNode(node.children[node.order[oi2]], depth + 1);
      }
      if (node.keys && node.keys.length) {
        node.keys.sort(function (a, b) { return cmpSort(_rowSortCache[a], _rowSortCache[b]); });
      }
    }

    function sortAttr(key) {
      var tip;
      if (sortKey !== key || !sortDir) tip = 'Click to sort descending';
      else if (sortDir === 'desc') tip = 'Sorted descending — click to sort ascending';
      else tip = 'Sorted ascending — click to clear sort';
      return ' data-sort-key="' + esc(key) + '"' + (sortKey === key && sortDir ? ' data-sort-dir="' + sortDir + '"' : '') + ' title="' + esc(tip) + '"';
    }
    function sortIndicator(key) {
      if (sortKey !== key || !sortDir) return '<span class="pivot-sort-ind">⇅</span>';
      return '<span class="pivot-sort-ind pivot-sort-active">' + (sortDir === 'asc' ? '▲' : '▼') + '</span>';
    }

    var h = '<div class="pivot-result-scroll"><table class="pivot-table"><thead>';

    // Total number of header rows: col fields levels + (1 if multi-measure)
    var headerRowCount = (showCols ? numColFields : 0) + (isMulti ? 1 : 0);
    if (headerRowCount === 0) headerRowCount = 1; // single header row for no-col case
    var measureLabel = function (m) { return m.label || (AGG_REGISTRY[m.aggregator] ? AGG_REGISTRY[m.aggregator].label : m.aggregator) + (m.field ? '(' + m.field + ')' : ''); };

    if (showCols && numColFields > 1) {
      // ---- MULTI-LEVEL COLUMN HEADERS ----
      for (var level = 0; level < numColFields; level++) {
        h += '<tr>';

        if (level === 0) {
          for (var rf = 0; rf < (rowFields.length || 1); rf++) {
            var rfKey = 'row:' + rf;
            h += '<th class="pivot-row-header pivot-sortable" rowspan="' + headerRowCount + '"' + sortAttr(rfKey) + '>' +
              esc(rowFields.length > 0 ? rowFields[rf] : 'Row') + sortIndicator(rfKey) + '</th>';
          }
        }

        var lastGroupKey = null;
        for (var ci = 0; ci < colValues.length; ci++) {
          var parts = colParts(colValues[ci]);
          if (level < numColFields - 1) {
            var parentKey = '';
            for (var pl = 0; pl <= level; pl++) {
              parentKey += (pl > 0 ? '\x00' : '') + parts[pl];
            }
            if (parentKey !== lastGroupKey) {
              var span = 0;
              for (var si = ci; si < colValues.length; si++) {
                var sp = colParts(colValues[si]);
                var sk = '';
                for (var skl = 0; skl <= level; skl++) {
                  sk += (skl > 0 ? '\x00' : '') + sp[skl];
                }
                if (sk === parentKey) span++;
                else break;
              }
              // Each colValue leaf occupies numMeasures cells
              h += '<th class="pivot-col-header" colspan="' + (span * numMeasures) + '">' + esc(parts[level]) + '</th>';
              lastGroupKey = parentKey;
            }
          } else {
            // Leaf level: one header per colValue, spanning numMeasures if multi-measure
            // In single-measure mode, header itself is the sort target (col:cv|0)
            var cvLeaf = colValues[ci];
            var leafKey = !isMulti ? 'col:' + cvLeaf + '|0' : '';
            h += '<th class="pivot-col-header' + (!isMulti ? ' pivot-sortable' : '') + '"' + (isMulti ? ' colspan="' + numMeasures + '"' : sortAttr(leafKey)) + '>' + esc(parts[level]) + (!isMulti ? sortIndicator(leafKey) : '') + '</th>';
          }
        }

        if (level === 0 && showRowTotal) {
          var rtKey0 = !isMulti ? 'rowTotal:0' : '';
          h += '<th class="pivot-total-header' + (!isMulti ? ' pivot-sortable' : '') + '" rowspan="' + headerRowCount + '"' + (isMulti ? ' colspan="' + numMeasures + '"' : sortAttr(rtKey0)) + '>' + esc(rowTotalLabel) + (!isMulti ? sortIndicator(rtKey0) : '') + '</th>';
        }
        h += '</tr>';
      }
      // Extra measure header row if multi-measure
      if (isMulti) {
        h += '<tr>';
        for (var ci_m = 0; ci_m < colValues.length; ci_m++) {
          for (var mmi = 0; mmi < numMeasures; mmi++) {
            var mk = 'col:' + colValues[ci_m] + '|' + mmi;
            h += '<th class="pivot-measure-header pivot-sortable"' + sortAttr(mk) + '>' + esc(measureLabel(measures[mmi])) + sortIndicator(mk) + '</th>';
          }
        }
        h += '</tr>';
      }

    } else {
      // ---- SINGLE-LEVEL HEADER (0 or 1 column field) ----
      // Special case: no col fields → measure labels inline (no "Values" wrapper), works for 1+ measures
      var noColMeasures = !showCols;
      var needsMeasureRow = isMulti && showCols;
      h += '<tr>';
      if (rowFields.length > 0) {
        for (var rf2 = 0; rf2 < rowFields.length; rf2++) {
          var rfKey2 = 'row:' + rf2;
          h += '<th class="pivot-row-header pivot-sortable"' + (needsMeasureRow ? ' rowspan="2"' : '') + sortAttr(rfKey2) + '>' + esc(rowFields[rf2]) + sortIndicator(rfKey2) + '</th>';
        }
      } else {
        h += '<th class="pivot-row-header"' + (needsMeasureRow ? ' rowspan="2"' : '') + '>Row</th>';
      }
      if (showCols) {
        for (var ci2 = 0; ci2 < colValues.length; ci2++) {
          var cvS = colValues[ci2];
          var singleKey = !isMulti ? 'col:' + cvS + '|0' : '';
          h += '<th class="pivot-col-header' + (!isMulti ? ' pivot-sortable' : '') + '"' + (isMulti ? ' colspan="' + numMeasures + '"' : sortAttr(singleKey)) + '>' + esc(colParts(cvS).join(' / ')) + (!isMulti ? sortIndicator(singleKey) : '') + '</th>';
        }
      } else if (noColMeasures) {
        // Measure labels directly in header row 1 (single or multi-measure) — each is a data column
        // Sort key: rowTotal:M (since no col grouping, measure column = row total)
        for (var mh = 0; mh < numMeasures; mh++) {
          var mhKey = 'rowTotal:' + mh;
          h += '<th class="pivot-col-header pivot-sortable"' + sortAttr(mhKey) + '>' + esc(measureLabel(measures[mh])) + sortIndicator(mhKey) + '</th>';
        }
      }
      if (showRowTotal) {
        var rtKey1 = !isMulti ? 'rowTotal:0' : '';
        h += '<th class="pivot-total-header' + (!isMulti ? ' pivot-sortable' : '') + '"' + (needsMeasureRow ? ' rowspan="2" colspan="' + numMeasures + '"' : sortAttr(rtKey1)) + '>' + esc(rowTotalLabel) + (!isMulti ? sortIndicator(rtKey1) : '') + '</th>';
      }
      h += '</tr>';
      // Multi-measure with col fields: add second row with measure labels under each col value
      if (needsMeasureRow) {
        h += '<tr>';
        for (var ch = 0; ch < colValues.length; ch++) {
          for (var mmi2 = 0; mmi2 < numMeasures; mmi2++) {
            var mk2 = 'col:' + colValues[ch] + '|' + mmi2;
            h += '<th class="pivot-measure-header pivot-sortable"' + sortAttr(mk2) + '>' + esc(measureLabel(measures[mmi2])) + sortIndicator(mk2) + '</th>';
          }
        }
        h += '</tr>';
      }
    }

    h += '</thead><tbody>';

    // Build nested group tree: by first rowField value, then second, etc.
    // Used for multi-level subtotals + collapse support.
    function buildGroupTree(keys) {
      var root = { children: {}, order: [], keys: [] };
      for (var i = 0; i < keys.length; i++) {
        var rk = keys[i];
        var parts = rowFieldValues[rk] || [];
        var node = root;
        for (var lvl = 0; lvl < rowFields.length - 1; lvl++) {
          var v = parts[lvl];
          if (!node.children[v]) { node.children[v] = { children: {}, order: [], keys: [], path: (node.path || []).concat([v]) }; node.order.push(v); }
          node = node.children[v];
          node.keys.push(rk);
        }
        root.keys.push(rk);
      }
      return root;
    }

    // Render one data row
    function renderDataRow(rk) {
      var rd = tree[rk];
      var parts = rowFieldValues[rk] || [rk];
      var r = '<tr class="pivot-row">';
      for (var rfi = 0; rfi < numRowCols; rfi++) {
        r += '<td class="pivot-row-label"' + sf(aRow, sRow) + '>' + esc(parts[rfi] ?? '') + '</td>';
      }
      if (showCols) {
        for (var cj = 0; cj < colValues.length; cj++) {
          var cells = rd.cells[colValues[cj]] || [];
          var rowsList = cells.map(function (c) { return c.row; });
          for (var mi = 0; mi < numMeasures; mi++) {
            r += renderCell(cells, rowsList, measures[mi], aVal, sVal, null, rk, colValues[cj]);
          }
        }
      } else {
        for (var mi2 = 0; mi2 < numMeasures; mi2++) {
          r += renderCell(rd.values, rd.rows, measures[mi2], aVal, sVal, null, rk, '(All)');
        }
      }
      if (showRowTotal) {
        // Prefer backend per-row total (correct for non-reaggregable); fallback to re-aggregating cells
        // Special case: no row fields → use overall grand total row (same as Grand Total row's Row Total)
        var leafRow = null;
        if (rowFields.length > 0) {
          var leafLevel = rowFields.length - 1;
          var leafPathKey = (rowFieldValues[rk] || []).slice(0, leafLevel + 1).join('\x00');
          leafRow = subtotalOverallLookup[leafLevel + ':' + leafPathKey];
        } else if (serverGrandTotals && serverGrandTotals.length) {
          for (var gi = 0; gi < serverGrandTotals.length; gi++) {
            if (serverGrandTotals[gi]._pivot_overall) { leafRow = serverGrandTotals[gi]; break; }
          }
          if (!leafRow && !colFields.length) leafRow = serverGrandTotals[0];
        }
        for (var mi3 = 0; mi3 < numMeasures; mi3++) {
          var bv;
          if (leafRow) {
            bv = leafRow['_pivot_m_' + mi3];
            if (bv === undefined && mi3 === 0) bv = leafRow['_pivot_value'];
          }
          if (bv !== undefined) {
            var v = measures[mi3].aggregator === 'share'
              ? stShareAdjust(bv, mi3)
              : bv;
            r += '<td class="pivot-cell pivot-total-cell"' + sf(aRT, sRT, cfStyle(v, measures[mi3], true)) + '>' + fmtVal(v, measures[mi3]) + '</td>';
          } else {
            r += renderCell(rd.values, rd.rows, measures[mi3], aRT, sRT, 'pivot-total-cell', rk, null);
          }
        }
      }
      r += '</tr>';
      return r;
    }

    // Render subtotal row for a group (can be any level)
    // path: array of values identifying the group (e.g. ["APAC","Japan"])
    // depth: which row-field level the label sits in (0 = first)
    // groupKeys: all rowKeys under this group
    // Build lookup for server-provided subtotals by (level, rowPath, colKey)
    var subtotalLookup = {};
    var subtotalOverallLookup = {};
    // Share adjustment helper (needed by both subtotal and data rows)
    function stShareAdjust(val, mi) {
      if (val === undefined || val === null) return val;
      var m = measures[mi];
      if (!m || m.aggregator !== 'share') return val;
      var denom = NaN;
      if (serverGrandTotals && serverGrandTotals.length) {
        for (var gi = 0; gi < serverGrandTotals.length; gi++) {
          var gRow = serverGrandTotals[gi];
          if (gRow._pivot_overall || !colFields.length) {
            var dv = gRow['_pivot_m_' + mi];
            if (dv === undefined && mi === 0) dv = gRow['_pivot_value'];
            denom = parseFloat(dv);
            break;
          }
        }
      }
      if (!isNaN(denom) && denom > 0) return parseFloat(val) / denom;
      return val;
    }
    if (serverSubtotals && serverSubtotals.length) {
      for (var sti = 0; sti < serverSubtotals.length; sti++) {
        var srow = serverSubtotals[sti];
        var lvl = srow._pivot_subtotal_level;
        if (lvl === undefined) continue;
        var rowPathParts = [];
        for (var rli = 0; rli <= lvl; rli++) rowPathParts.push(srow[rowFields[rli]] ?? '(empty)');
        var rowPathKey = rowPathParts.join('\x00');
        if (srow._pivot_overall) {
          subtotalOverallLookup[lvl + ':' + rowPathKey] = srow;
        } else {
          var colParts_ = colFields.length ? colFields.map(function (f) { return srow[f] ?? '(empty)'; }) : [];
          var colKey_ = colParts_.join('\x00');
          subtotalLookup[lvl + ':' + rowPathKey + ':' + colKey_] = srow;
        }
      }
    }

    // Simple subtotal row: label spanning all row-field cols + per-cell aggregate values
    // Uses server subtotals when available (for non-reaggregable aggregators)
    function renderSubtotalRow(path, depth, groupKeys, groupLabel) {
      var stLabel = subtotalLabel.replace(/\{group\}/gi, groupLabel || (path.length ? path[path.length - 1] : ''));
      var r = '<tr class="pivot-subtotal">';
      r += '<td class="pivot-row-label" colspan="' + numRowCols + '"' + sf(aST, sST) + '>' + esc(stLabel) + '</td>';
      // Lookup key
      var rowPathKey = path.join('\x00');
      function srvCellVal(colKey, mi) {
        var row = subtotalLookup[depth + ':' + rowPathKey + ':' + colKey];
        if (!row) return undefined;
        if (row['_pivot_m_' + mi] !== undefined) return row['_pivot_m_' + mi];
        if (mi === 0 && row['_pivot_value'] !== undefined) return row['_pivot_value'];
        return undefined;
      }
      function srvOverallVal(mi) {
        var row = subtotalOverallLookup[depth + ':' + rowPathKey];
        if (!row) {
          // If no col fields, the main subtotalLookup with empty colKey IS the overall
          if (!colFields.length) row = subtotalLookup[depth + ':' + rowPathKey + ':'];
        }
        if (!row) return undefined;
        if (row['_pivot_m_' + mi] !== undefined) return row['_pivot_m_' + mi];
        if (mi === 0 && row['_pivot_value'] !== undefined) return row['_pivot_value'];
        return undefined;
      }
      // Aggregate cells across groupKeys
      function collectCells(ck) {
        var out = [], outRows = [];
        for (var i = 0; i < groupKeys.length; i++) {
          var cs = (tree[groupKeys[i]] && tree[groupKeys[i]].cells[ck]) || [];
          for (var j = 0; j < cs.length; j++) { out.push(cs[j]); outRows.push(cs[j].row); }
        }
        return { cells: out, rows: outRows };
      }
      function collectAll() {
        var out = [], outRows = [];
        for (var i = 0; i < groupKeys.length; i++) {
          var v = tree[groupKeys[i]].values;
          for (var j = 0; j < v.length; j++) { out.push(v[j]); outRows.push(v[j].row); }
        }
        return { cells: out, rows: outRows };
      }
      var hasServerSubtotal = Object.keys(subtotalLookup).length > 0 || Object.keys(subtotalOverallLookup).length > 0;
      if (showCols) {
        for (var sc = 0; sc < colValues.length; sc++) {
          for (var mi = 0; mi < numMeasures; mi++) {
            var v = hasServerSubtotal ? srvCellVal(colValues[sc], mi) : undefined;
            if (v !== undefined) {
              var vAdj = stShareAdjust(v, mi);
              r += '<td class="pivot-cell"' + sf(aST, sST, cfStyle(vAdj, measures[mi], true)) + '>' + fmtVal(vAdj, measures[mi]) + '</td>';
            } else {
              var cc = collectCells(colValues[sc]);
              r += renderCell(cc.cells, cc.rows, measures[mi], aST, sST, 'pivot-total-cell');
            }
          }
        }
      } else {
        for (var mi2 = 0; mi2 < numMeasures; mi2++) {
          var v2 = hasServerSubtotal ? srvOverallVal(mi2) : undefined;
          if (v2 !== undefined) {
            var v2Adj = stShareAdjust(v2, mi2);
            r += '<td class="pivot-cell"' + sf(aST, sST, cfStyle(v2Adj, measures[mi2], true)) + '>' + fmtVal(v2Adj, measures[mi2]) + '</td>';
          } else {
            var allG = collectAll();
            r += renderCell(allG.cells, allG.rows, measures[mi2], aST, sST, 'pivot-total-cell');
          }
        }
      }
      if (showRowTotal) {
        for (var mi3 = 0; mi3 < numMeasures; mi3++) {
          var v3 = hasServerSubtotal ? srvOverallVal(mi3) : undefined;
          if (v3 !== undefined) {
            var v3Adj = stShareAdjust(v3, mi3);
            r += '<td class="pivot-cell pivot-total-cell"' + sf(aST, sST, cfStyle(v3Adj, measures[mi3], true)) + '>' + fmtVal(v3Adj, measures[mi3]) + '</td>';
          } else {
            var allRT = collectAll();
            r += renderCell(allRT.cells, allRT.rows, measures[mi3], aST, sST, 'pivot-total-cell');
          }
        }
      }
      r += '</tr>';
      return r;
    }

    // ---- PAGINATION ----
    var pageSize = config.pageSize || 0; // 0 = all
    var isBackendPaged = _serverTotal !== null && _serverTotal !== undefined;
    var totalDataRows = isBackendPaged ? _serverTotal : rowKeys.length;
    var totalPages = pageSize > 0 ? Math.ceil(totalDataRows / pageSize) : 1;
    var currentPage = getPivotPage(config._componentName || '') || 0;
    if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);

    // Determine which row keys to show on this page
    var pageRowKeys;
    if (isBackendPaged) {
      pageRowKeys = rowKeys;
    } else if (pageSize > 0) {
      var startIdx = currentPage * pageSize;
      var endIdx = Math.min(startIdx + pageSize, totalDataRows);
      pageRowKeys = rowKeys.slice(startIdx, endIdx);
    } else {
      pageRowKeys = rowKeys;
    }

    // ---- RENDER BODY ----
    // Render data rows; if showSubtotal, insert "{group} Subtotal" row after each first-level group
    if (showSubtotal) {
      var groupTree = buildGroupTree(pageRowKeys);
      sortTreeNode(groupTree, 0);
      function renderGroup(node, depth) {
        if (depth >= rowFields.length - 1 || !node.order || !node.order.length) {
          for (var li = 0; li < node.keys.length; li++) {
            h += renderDataRow(node.keys[li]);
          }
          return;
        }
        var seen = {};
        for (var oi = 0; oi < node.order.length; oi++) {
          var gVal = node.order[oi];
          if (seen[gVal]) continue; seen[gVal] = true;
          var child = node.children[gVal]; if (!child) continue;
          var childPath = (node.path || []).concat([gVal]);
          renderGroup(child, depth + 1);
          h += renderSubtotalRow(childPath, depth, child.keys, gVal);
        }
      }
      renderGroup(groupTree, 0);
    } else {
      for (var ri = 0; ri < pageRowKeys.length; ri++) {
        h += renderDataRow(pageRowKeys[ri]);
      }
    }

    // ---- GRAND TOTAL ROW ----
    if (showGrandTotal) {
      h += '<tr class="pivot-grand-total">';
      h += '<td class="pivot-row-label" colspan="' + numRowCols + '"' + sf(aGT, sGT) + '>' + esc(grandTotalLabel) + '</td>';

      // Collect all cells across all rowKeys (for per-column grand total)
      function collectColCells(ck) {
        var cells = [], rows = [];
        for (var i = 0; i < rowKeys.length; i++) {
          var cs = (tree[rowKeys[i]] && tree[rowKeys[i]].cells[ck]) || [];
          for (var j = 0; j < cs.length; j++) { cells.push(cs[j]); rows.push(cs[j].row); }
        }
        return { cells: cells, rows: rows };
      }
      function collectAllGT() {
        var cells = [], rows = [];
        for (var i = 0; i < rowKeys.length; i++) {
          var v = tree[rowKeys[i]].values;
          for (var j = 0; j < v.length; j++) { cells.push(v[j]); rows.push(v[j].row); }
        }
        return { cells: cells, rows: rows };
      }

      if (serverGrandTotals && serverGrandTotals.length > 0) {
        // Use server-computed grand totals — correct for ALL aggregators (including non-reaggregable)
        // Server rows have _pivot_m_0, _pivot_m_1, ... columns (multi-measure) and optionally _pivot_value (single-measure back-compat)
        // Build lookup: colKey → gtRow
        var gtMap = {};
        var overallRow = null;
        for (var gti = 0; gti < serverGrandTotals.length; gti++) {
          var gtRow = serverGrandTotals[gti];
          if (gtRow._pivot_overall) {
            overallRow = gtRow; // explicit overall row from backend (no col grouping)
            continue;
          }
          if (colFields.length) {
            var gtColParts = colFields.map(function (f) { return gtRow[f] ?? '(empty)'; });
            gtMap[gtColParts.join('\x00')] = gtRow;
          } else {
            overallRow = gtRow; // no col fields → single row IS the overall
          }
        }
        function gtValForMeasure(row, mi) {
          if (!row) return undefined;
          if (row['_pivot_m_' + mi] !== undefined) return row['_pivot_m_' + mi];
          if (mi === 0 && row['_pivot_value'] !== undefined) return row['_pivot_value'];
          return undefined;
        }
        // For share measures: the displayed value must be divided by overall total (denominator)
        // so Grand Total row shows column_sum / overall_sum (a percentage).
        function applyShareAdjustment(val, mi) {
          if (val === undefined || val === null) return val;
          var m = measures[mi];
          if (!m || m.aggregator !== 'share') return val;
          var total = overallRow ? parseFloat(gtValForMeasure(overallRow, mi)) : NaN;
          if (!isNaN(total) && total > 0) return parseFloat(val) / total;
          return val;
        }
        if (showCols) {
          for (var ck_ = 0; ck_ < colValues.length; ck_++) {
            var rowCK = gtMap[colValues[ck_]];
            for (var mi_ = 0; mi_ < numMeasures; mi_++) {
              var v__ = applyShareAdjustment(gtValForMeasure(rowCK, mi_), mi_);
              h += '<td class="pivot-cell"' + sf(aGT, sGT, cfStyle(v__, measures[mi_], true)) + '>' + (v__ !== undefined ? fmtVal(v__, measures[mi_]) : esc(emptyVal)) + '</td>';
            }
          }
        } else {
          for (var mi_no = 0; mi_no < numMeasures; mi_no++) {
            var vNC = applyShareAdjustment(gtValForMeasure(overallRow, mi_no), mi_no);
            h += '<td class="pivot-cell"' + sf(aGT, sGT, cfStyle(vNC, measures[mi_no], true)) + '>' + (vNC !== undefined ? fmtVal(vNC, measures[mi_no]) : esc(emptyVal)) + '</td>';
          }
        }
        if (showRowTotal) {
          // Row total = aggregate across all columns. For most aggregators we can compute via
          // cross-column reduction; for non-reaggregable, we use the overall grand total row (computed without GROUP BY colFields).
          // Use overallRow if available (no col fields case); otherwise compute by reducing per-column server values.
          for (var mi3 = 0; mi3 < numMeasures; mi3++) {
            var m3 = measures[mi3];
            var gtDisplay;
            if (overallRow) {
              gtDisplay = applyShareAdjustment(gtValForMeasure(overallRow, mi3), mi3);
            } else {
              // Reduce across per-column server values (sum for sum-like, avg with weight for avg, etc.)
              var vals = [];
              for (var ck2 = 0; ck2 < colValues.length; ck2++) {
                var r_ = gtMap[colValues[ck2]];
                var v_ = r_ ? gtValForMeasure(r_, mi3) : undefined;
                if (v_ !== undefined && v_ !== null) vals.push(parseFloat(v_));
              }
              if (m3.aggregator === 'avg' || m3.aggregator === 'share') {
                var sum_ = 0, n_ = 0;
                for (var z_ = 0; z_ < vals.length; z_++) { if (!isNaN(vals[z_])) { sum_ += vals[z_]; n_++; } }
                gtDisplay = n_ ? sum_ / n_ : 0;
              } else if (m3.aggregator === 'min') {
                gtDisplay = vals.length ? Math.min.apply(null, vals) : '';
              } else if (m3.aggregator === 'max') {
                gtDisplay = vals.length ? Math.max.apply(null, vals) : '';
              } else {
                // sum, count, sum-where, count-where, cum-sum, cum-count, expr, distinct, median, stddev, percentile, variance
                // For non-reaggregable: best approximation is server's per-column value; user should check grand total source.
                // For sum-like: sum of partials.
                var s2 = 0;
                for (var z2 = 0; z2 < vals.length; z2++) { if (!isNaN(vals[z2])) s2 += vals[z2]; }
                gtDisplay = s2;
              }
            }
            h += '<td class="pivot-cell pivot-total-cell"' + sf(aGT, sGT, cfStyle(gtDisplay, m3, true)) + '>' + (gtDisplay !== undefined && gtDisplay !== null && gtDisplay !== '' ? fmtVal(gtDisplay, m3) : esc(emptyVal)) + '</td>';
          }
        }
      } else {
        // Frontend computation via registry
        if (showCols) {
          for (var ck_fe = 0; ck_fe < colValues.length; ck_fe++) {
            var cc = collectColCells(colValues[ck_fe]);
            for (var mi = 0; mi < numMeasures; mi++) {
              h += renderCell(cc.cells, cc.rows, measures[mi], aGT, sGT, 'pivot-total-cell');
            }
          }
        } else {
          var allNoCol = collectAllGT();
          for (var mi2 = 0; mi2 < numMeasures; mi2++) {
            h += renderCell(allNoCol.cells, allNoCol.rows, measures[mi2], aGT, sGT, 'pivot-total-cell');
          }
        }
        if (showRowTotal) {
          var allRT = collectAllGT();
          for (var mi3 = 0; mi3 < numMeasures; mi3++) {
            h += renderCell(allRT.cells, allRT.rows, measures[mi3], aGT, sGT, 'pivot-total-cell');
          }
        }
      }
      h += '</tr>';
    }

    h += '</tbody></table></div>';

    // Pagination bar (only if pageSize > 0 and more than 1 page)
    if (pageSize > 0 && totalPages > 1) {
      h += '<div class="pivot-pagination">';
      h += '<span class="pivot-page-info">Page ' + (currentPage + 1) + ' of ' + totalPages + ' (' + totalDataRows + ' rows)</span>';
      h += '<div class="pivot-page-btns">';
      h += '<button class="pivot-page-btn pivot-page-first" ' + (currentPage === 0 ? 'disabled' : '') + ' data-page="0" title="First">&laquo;</button>';
      h += '<button class="pivot-page-btn pivot-page-prev" ' + (currentPage === 0 ? 'disabled' : '') + ' data-page="' + (currentPage - 1) + '" title="Previous">&lsaquo;</button>';
      h += '<button class="pivot-page-btn pivot-page-next" ' + (currentPage >= totalPages - 1 ? 'disabled' : '') + ' data-page="' + (currentPage + 1) + '" title="Next">&rsaquo;</button>';
      h += '<button class="pivot-page-btn pivot-page-last" ' + (currentPage >= totalPages - 1 ? 'disabled' : '') + ' data-page="' + (totalPages - 1) + '" title="Last">&raquo;</button>';
      h += '</div></div>';
    }

    return h;
  }

  // =====================================================================
  //  EDITOR MODE
  // =====================================================================
  if (isEditor) {
    var SECTION_ID = 'pivot-inspector-section';
    var activeWidget = null;
    var _activeComponentId = null; // track component UUID to detect page switches with same name
    var _configLoadPending = false;
    var _configRetryCount = 0;
    var _previousWidget = null; // track previous widget for rename detection
    var cachedColumns = [];

    // In-memory config cache — single source of truth, never lost on DOM removal
    var configCache = {};

    // Get config: memory first, then localStorage, then default
    function getConfig(widgetName) {
      if (configCache[widgetName]) return configCache[widgetName];
      var stored = loadConfig(widgetName);
      if (stored) { configCache[widgetName] = stored; return stored; }
      return defaultConfig();
    }

    // Set config: update memory + localStorage
    function setConfig(widgetName, config) {
      configCache[widgetName] = config;
      saveConfig(widgetName, config, _componentIdMap[widgetName]);
    }

    // Get currently selected widget name from Inspector
    function getWidgetName() {
      var input = document.querySelector('input[data-cy="edit-widget-name"]');
      return input ? input.value.trim() : null;
    }

    // Check if currently selected component is a Table
    function isTableInspector() {
      var name = getWidgetName();
      if (!name) return false;
      // Check canvas element has .table-component class (unique to Table widget)
      var el = document.querySelector('[data-cy="draggable-widget-' + name + '"]');
      if (el && el.querySelector('.jet-table.table-component')) return true;
      // Fallback: check if element itself has table-component
      if (el && el.classList && el.classList.contains('table-component')) return true;
      return false;
    }

    // Find the .accordion container inside the Properties tab
    function findAccordion() {
      var dataSection = document.querySelector('[data-cy="widget-accordion-data"]');
      if (!dataSection) return null;
      var item = dataSection.closest('.accordion-item');
      if (!item) return null;
      return item.parentElement; // the .accordion div
    }

    // When pivot is enabled, inject a <style> tag that hides Table UI elements
    // Uses data-cy selector which React doesn't remove on re-render
    var _pivotStyleTags = {}; // componentId -> style element

    function applyTableOverrides(pivotEnabled) {
      var cid = _activeComponentId;
      var wname = activeWidget;
      if (!wname) return;

      // Remove existing style tag for this component
      if (_pivotStyleTags[cid || wname]) {
        _pivotStyleTags[cid || wname].remove();
        delete _pivotStyleTags[cid || wname];
      }

      if (!pivotEnabled) return;

      // Inject CSS targeting this specific widget
      var selector = '[data-cy="draggable-widget-' + wname + '"]';
      var css = selector + ' .table-card-header,' +
        selector + ' .table-global-search,' +
        selector + ' [data-cy$="-filter-button"],' +
        selector + ' [data-cy$="-search-bar"],' +
        selector + ' .jet-table-footer,' +
        selector + ' .table-footer,' +
        selector + ' .table-footer-section,' +
        selector + ' .pagination-section' +
        '{ display: none !important; }';
      var style = document.createElement('style');
      style.textContent = css;
      style.setAttribute('data-pivot-override', wname);
      document.head.appendChild(style);
      _pivotStyleTags[cid || wname] = style;
    }

    // Refresh column list from the table on the canvas
    function refreshColumns(widgetName) {
      var tableEl = document.querySelector('[data-cy="draggable-widget-' + widgetName + '"]');
      if (tableEl) {
        var cols = extractColumns(tableEl);
        if (cols.length > 0) {
          // If columns changed, clear data cache so it re-extracts with new column names
          if (JSON.stringify(cols) !== JSON.stringify(cachedColumns)) {
            delete dataCache[widgetName];
            console.log(LOG_PREFIX, 'Columns changed, cleared data cache for', widgetName);
          }
          cachedColumns = cols;
        }
      }
    }

    // ---- BUILD THE ACCORDION SECTION ----
    function buildSection(config) {
      var el = document.createElement('div');
      el.className = 'accordion-item';
      el.id = SECTION_ID;

      // Build header (matches ToolJet's AccordionItem structure)
      var headerHTML =
        '<h2 class="accordion-header" data-cy="widget-accordion-pivot-table" style="cursor:pointer">' +
        '<div class="accordion-button inspector">' +
        '<span class="text-capitalize accordion-title-text tw-text-sm tw-text-text-default" ' +
        'data-cy="label-pivot-table" style="font-size:12px">Pivot Table</span>' +
        '<div class="accordion-item-trigger' + (config.enabled ? '' : ' collapsed') + '" ' +
        'data-cy="pivot-table-collapse-button" type="button">' +
        '<svg width="6" height="10" viewBox="0 0 6 10" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M1 1L5 5L1 9" stroke="var(--slate8,#889096)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg></div></div></h2>';

      // Build body
      var bodyHTML = '<div class="accordion-collapse collapse' + (config.enabled ? ' show' : '') + '">' +
        '<div class="accordion-body accordion-body-custom" style="padding:0rem 1rem 1rem 1rem">' +
        buildBody(config) +
        '</div></div>';

      el.innerHTML = headerHTML + bodyHTML;

      // Toggle collapse
      var h2 = el.querySelector('h2');
      var collapseDiv = el.querySelector('.accordion-collapse');
      var trigger = el.querySelector('.accordion-item-trigger');
      h2.addEventListener('click', function () {
        var open = collapseDiv.classList.contains('show');
        collapseDiv.classList.toggle('show', !open);
        trigger.classList.toggle('collapsed', open);
      });

      return el;
    }

    function buildBody(config) {
      var h = '';

      // Enable toggle
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Enable Pivot</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-enable"' + (config.enabled ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';

      // Fields container (hidden when disabled)
      h += '<div class="pivot-cfg-fields"' + (config.enabled ? '' : ' style="display:none"') + '>';

      // Show Title toggle
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Show Title</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-showTitle"' + (config.showTitle !== false ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';

      // Title alias
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Title Alias</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-cfg-titleAlias" value="' + esc(config.titleAlias || '') + '" placeholder="Auto (widget name)"/>';
      h += '</div>';

      // Row Fields (ordered picker)
      h += '<div class="pivot-prop-row pivot-prop-row-stack">';
      h += '<label class="pivot-prop-label">Row Fields</label>';
      h += buildOrderedPicker('rowFields', config.rowFields);
      h += '</div>';

      // Column Fields (ordered picker)
      h += '<div class="pivot-prop-row pivot-prop-row-stack">';
      h += '<label class="pivot-prop-label">Column Fields</label>';
      h += buildOrderedPicker('colFields', config.colFields);
      h += '</div>';

      // --- Measures section (replaces single Value Field + Aggregation) ---
      h += '<div class="pivot-section-label">Measures</div>';
      h += '<div class="pivot-measures-list" data-zone="measures">';
      var mList = config.measures || [];
      for (var mi = 0; mi < mList.length; mi++) {
        h += buildMeasureRow(mList[mi], mi, config);
      }
      h += '</div>';
      h += '<div class="pivot-prop-row">';
      h += '<button class="pivot-add-measure-btn" type="button">+ Add Measure</button>';
      h += '</div>';

      // --- Backend Pivot section (always visible, auto-detect controls editability) ---
      h += '<div class="pivot-backend-section">';
      h += '<div class="pivot-section-label">Data Source</div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Backend Pivot</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-backendPivot"' + (config.backendPivot ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '<div class="pivot-backend-info pivot-hint">Detecting datasource...</div>';
      h += '</div>';

      // --- Totals section ---
      h += '<div class="pivot-section-label">Totals</div>';

      // Row Total (rightmost column)
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Row Total</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-showRowTotal"' + (config.showRowTotal !== false ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Label</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-cfg-rowTotalLabel" value="' + esc(config.rowTotalLabel || 'Total') + '" placeholder="Total"/>';
      h += '</div>';

      // Grand Total (bottom row)
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Grand Total</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-showGrandTotal"' + (config.showGrandTotal !== false ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Label</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-cfg-grandTotalLabel" value="' + esc(config.grandTotalLabel || 'Grand Total') + '" placeholder="Grand Total"/>';
      h += '</div>';

      // Subtotals (rows grouped by first field)
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Subtotals</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-showSubtotal"' + (config.showSubtotal ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Label</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-cfg-subtotalLabel" value="' + esc(config.subtotalLabel || '{group} Subtotal') + '" placeholder="{group} Subtotal"/>';
      h += '</div>';
      h += '<div class="pivot-prop-row"><span style="font-size:11px;color:#888;line-height:1.3">Use <b>{group}</b> for group name.<br>E.g: <i>{group} Subtotal</i>, <i>Subtotal of {group}</i>, <i>Total ({group})</i></span></div>';

      // --- Alignment & Style section ---
      // Empty cell display
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Empty Cell</label>';
      h += '<select class="pivot-cfg-select pivot-cfg-emptyValue">';
      var emptyOpts = [['0', '0'], ['', '(empty)'], ['null', 'Null'], ['-', '-'], ['N/A', 'N/A']];
      for (var ei = 0; ei < emptyOpts.length; ei++) {
        var eVal = emptyOpts[ei][0], eLabel = emptyOpts[ei][1];
        h += '<option value="' + esc(eVal) + '"' + ((config.emptyValue !== undefined ? config.emptyValue : '0') === eVal ? ' selected' : '') + '>' + esc(eLabel) + '</option>';
      }
      h += '</select></div>';

      h += '<div class="pivot-section-label">Formatting</div>';

      // Decimal places
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Decimals</label>';
      h += '<select class="pivot-cfg-select pivot-cfg-decimalPlaces">';
      var dpOpts = [['auto', 'Auto'], ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'], ['10', '10']];
      var curDP = config.decimalPlaces !== undefined ? String(config.decimalPlaces) : 'auto';
      for (var dpi = 0; dpi < dpOpts.length; dpi++) {
        h += '<option value="' + dpOpts[dpi][0] + '"' + (curDP === dpOpts[dpi][0] ? ' selected' : '') + '>' + dpOpts[dpi][1] + '</option>';
      }
      h += '</select></div>';

      h += buildFormatRow('Row Fields', 'RowFields', config);
      h += buildFormatRow('Values', 'ColValues', config);
      h += buildFormatRow('Row Total', 'RowTotal', config);
      h += buildFormatRow('Grand Total', 'GrandTotal', config);
      h += buildFormatRow('Subtotals', 'Subtotal', config);

      // --- Conditional Formatting ---
      h += '<div class="pivot-section-label">Conditional Formatting</div>';
      h += '<div class="pivot-cf-list" data-zone="cf">';
      var cfList = config.conditionalFormats || [];
      for (var cfi = 0; cfi < cfList.length; cfi++) {
        h += buildCFRow(cfList[cfi], cfi, config);
      }
      h += '</div>';
      h += '<div class="pivot-prop-row">';
      h += '<button class="pivot-add-cf-btn" type="button">+ Add Rule</button>';
      h += '</div>';

      // Page Size
      h += '<div class="pivot-section-label">Pagination</div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Page Size</label>';
      h += '<select class="pivot-cfg-select pivot-cfg-pageSize">';
      var pageSizes = [[0, 'All'], [10, '10'], [20, '20'], [50, '50'], [100, '100'], [500, '500'], [1000, '1000'], [2000, '2000']];
      var curPS = config.pageSize || 0;
      for (var pi = 0; pi < pageSizes.length; pi++) {
        h += '<option value="' + pageSizes[pi][0] + '"' + (curPS == pageSizes[pi][0] ? ' selected' : '') + '>' + pageSizes[pi][1] + '</option>';
      }
      h += '</select></div>';

      // Refresh columns button
      h += '<div class="pivot-prop-row">';
      h += '<button class="pivot-refresh-btn" type="button">Refresh Columns</button>';
      h += '</div>';

      h += '</div>'; // end pivot-cfg-fields
      return h;
    }

    // Build a single measure row (collapsible detail panel)
    function buildMeasureRow(measure, idx, config) {
      var usedFields = (config.rowFields || []).concat(config.colFields || []);
      var aggKeys = Object.keys(AGG_REGISTRY);
      var reg = AGG_REGISTRY[measure.aggregator] || AGG_REGISTRY.count;
      var needsField = measure.aggregator !== 'count' && measure.aggregator !== 'count-where' && measure.aggregator !== 'expr';
      var h = '<div class="pivot-measure-row" data-midx="' + idx + '" data-mid="' + esc(measure.id) + '">';
      // Summary (always visible)
      h += '<div class="pivot-measure-summary">';
      h += '<span class="pivot-measure-drag" title="Drag to reorder">&#x2630;</span>';
      h += '<span class="pivot-measure-label">' + esc(measure.label || (reg.label + (measure.field ? '(' + measure.field + ')' : ''))) + '</span>';
      h += '<span class="pivot-measure-toggle" data-midx="' + idx + '" title="Edit">&#9881;</span>';
      if ((config.measures || []).length > 1) {
        h += '<span class="pivot-measure-remove" data-midx="' + idx + '" title="Remove">&times;</span>';
      }
      h += '</div>';
      // Detail panel (toggle open)
      h += '<div class="pivot-measure-detail" style="display:none">';
      // Aggregator
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Aggregation</label>';
      h += '<select class="pivot-measure-agg pivot-cfg-select" data-midx="' + idx + '">';
      for (var ai = 0; ai < aggKeys.length; ai++) {
        var ak = aggKeys[ai];
        h += '<option value="' + ak + '"' + (measure.aggregator === ak ? ' selected' : '') + '>' + AGG_REGISTRY[ak].label + '</option>';
      }
      h += '</select></div>';
      // Field (hidden for count/count-where/expr)
      h += '<div class="pivot-prop-row pivot-measure-field-row"' + (needsField ? '' : ' style="display:none"') + '>';
      h += '<label class="pivot-prop-label">Field</label>';
      h += '<select class="pivot-measure-field pivot-cfg-select" data-midx="' + idx + '">';
      h += '<option value="">(none)</option>';
      for (var ci = 0; ci < cachedColumns.length; ci++) {
        var c = cachedColumns[ci];
        if (usedFields.indexOf(c) !== -1) continue;
        h += '<option value="' + esc(c) + '"' + (measure.field === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }
      h += '</select></div>';
      // Percentile
      h += '<div class="pivot-prop-row pivot-measure-pct-row"' + (measure.aggregator === 'percentile' ? '' : ' style="display:none"') + '>';
      h += '<label class="pivot-prop-label">Percentile</label>';
      h += '<input type="number" class="pivot-cfg-input pivot-measure-pct" data-midx="' + idx + '" min="0" max="1" step="0.01" value="' + (measure.percentile !== undefined ? measure.percentile : 0.95) + '"/>';
      h += '</div>';
      // Where clause (sum-where / count-where)
      h += '<div class="pivot-measure-where-row"' + ((measure.aggregator === 'sum-where' || measure.aggregator === 'count-where') ? '' : ' style="display:none"') + '>';
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Where field</label>';
      h += '<select class="pivot-measure-where-field pivot-cfg-select" data-midx="' + idx + '">';
      h += '<option value="">(none)</option>';
      for (var wi = 0; wi < cachedColumns.length; wi++) {
        var wc = cachedColumns[wi];
        var curF = measure.where && measure.where.field;
        h += '<option value="' + esc(wc) + '"' + (curF === wc ? ' selected' : '') + '>' + esc(wc) + '</option>';
      }
      h += '</select></div>';
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Op</label>';
      h += '<select class="pivot-measure-where-op pivot-cfg-select" data-midx="' + idx + '">';
      var ops = ['=', '!=', '>', '<', '>=', '<=', 'like', 'is null', 'is not null'];
      var curOp = (measure.where && measure.where.op) || '=';
      for (var oi = 0; oi < ops.length; oi++) { h += '<option value="' + ops[oi] + '"' + (curOp === ops[oi] ? ' selected' : '') + '>' + ops[oi] + '</option>'; }
      h += '</select></div>';
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Value</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-measure-where-val" data-midx="' + idx + '" value="' + esc((measure.where && measure.where.value) || '') + '"/>';
      h += '</div></div>';
      // Expression (for expr)
      h += '<div class="pivot-prop-row pivot-measure-expr-row"' + (measure.aggregator === 'expr' ? '' : ' style="display:none"') + '>';
      h += '<label class="pivot-prop-label">Expression</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-measure-expr" data-midx="' + idx + '" value="' + esc(measure.expression || '') + '" placeholder="SUM(revenue) - SUM(cost)"/>';
      h += '</div>';
      if (measure._exprError) {
        h += '<div class="pivot-prop-row pivot-measure-expr-err" style="color:#e5484d;font-size:11px">' + esc(measure._exprError) + '</div>';
      }
      // Label
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Label</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-measure-lbl" data-midx="' + idx + '" value="' + esc(measure.label || '') + '" placeholder="Auto"/>';
      h += '</div>';
      // Decimal places
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Decimals</label>';
      h += '<select class="pivot-measure-dp pivot-cfg-select" data-midx="' + idx + '">';
      var dpOpts = [['', 'Inherit'], ['auto', 'Auto'], ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']];
      var cur = measure.decimalPlaces !== undefined && measure.decimalPlaces !== null ? String(measure.decimalPlaces) : '';
      for (var di = 0; di < dpOpts.length; di++) { h += '<option value="' + dpOpts[di][0] + '"' + (cur === dpOpts[di][0] ? ' selected' : '') + '>' + dpOpts[di][1] + '</option>'; }
      h += '</select></div>';
      // Number format
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Format</label>';
      h += '<select class="pivot-measure-nf pivot-cfg-select" data-midx="' + idx + '">';
      var nfOpts = [['', 'Default'], ['comma', 'Comma'], ['percent', 'Percent'], ['currency', 'Currency']];
      var curNf = measure.numberFormat || '';
      for (var ni = 0; ni < nfOpts.length; ni++) { h += '<option value="' + nfOpts[ni][0] + '"' + (curNf === nfOpts[ni][0] ? ' selected' : '') + '>' + nfOpts[ni][1] + '</option>'; }
      h += '</select></div>';
      // Prefix + Suffix
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Prefix</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-measure-prefix" data-midx="' + idx + '" value="' + esc(measure.prefix || '') + '" placeholder="$"/></div>';
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Suffix</label>';
      h += '<input type="text" class="pivot-cfg-input pivot-measure-suffix" data-midx="' + idx + '" value="' + esc(measure.suffix || '') + '" placeholder=""/></div>';
      h += '</div>'; // end detail
      h += '</div>';
      return h;
    }

    // Conditional Formatting preset palettes (Metabase-inspired)
    var CF_COLOR_PRESETS = [
      { name: 'Green',  bg: '#D1FAE5', text: '#065F46' },
      { name: 'Red',    bg: '#FEE2E2', text: '#991B1B' },
      { name: 'Yellow', bg: '#FEF3C7', text: '#92400E' },
      { name: 'Blue',   bg: '#DBEAFE', text: '#1E40AF' },
      { name: 'Purple', bg: '#EDE9FE', text: '#5B21B6' },
      { name: 'Pink',   bg: '#FCE7F3', text: '#9D174D' },
      { name: 'Orange', bg: '#FED7AA', text: '#9A3412' },
      { name: 'Gray',   bg: '#F3F4F6', text: '#374151' },
    ];
    var CF_GRADIENT_PRESETS = [
      { name: 'White → Green',  min: '#FFFFFF', max: '#22C55E' },
      { name: 'White → Red',    min: '#FFFFFF', max: '#EF4444' },
      { name: 'White → Blue',   min: '#FFFFFF', max: '#3B82F6' },
      { name: 'White → Yellow', min: '#FFFFFF', max: '#EAB308' },
      { name: 'Red → Green',    min: '#EF4444', max: '#22C55E' },
      { name: 'Green → Red',    min: '#22C55E', max: '#EF4444' },
      { name: 'Blue → Red',     min: '#3B82F6', max: '#EF4444' },
    ];

    // Build a Conditional Formatting rule row (collapsible)
    function buildCFRow(rule, idx, config) {
      var measures = config.measures || [];
      var isGradient = rule.type === 'gradient';
      var opLabels = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', '=': '=', 'between': 'between' };
      var mLabel = 'All measures';
      if (rule.measureId !== 'all') {
        for (var mi = 0; mi < measures.length; mi++) {
          if (measures[mi].id === rule.measureId) {
            var reg = AGG_REGISTRY[measures[mi].aggregator] || { label: measures[mi].aggregator };
            mLabel = measures[mi].label || (reg.label + (measures[mi].field ? '(' + measures[mi].field + ')' : ''));
            break;
          }
        }
      }
      var previewCss = isGradient
        ? 'background:linear-gradient(90deg,' + esc(rule.minColor || '#fff') + ',' + esc(rule.maxColor || '#22c55e') + ')'
        : 'background:' + esc(rule.bgColor || '#d4f4dd') + (rule.textColor ? ';color:' + esc(rule.textColor) : '');
      var summary = isGradient
        ? 'Gradient · ' + esc(mLabel)
        : esc(mLabel) + ' ' + esc(opLabels[rule.operator] || rule.operator || '>') + ' ' +
          esc(rule.value1 !== undefined ? String(rule.value1) : '') +
          (rule.operator === 'between' ? ' · ' + esc(rule.value2 !== undefined ? String(rule.value2) : '') : '');

      var h = '<div class="pivot-cf-row" data-cfidx="' + idx + '" data-cfid="' + esc(rule.id) + '">';
      h += '<div class="pivot-cf-summary">';
      h += '<span class="pivot-cf-preview" style="' + previewCss + '"></span>';
      h += '<span class="pivot-cf-label">' + summary + '</span>';
      h += '<span class="pivot-cf-toggle" title="Edit">&#9881;</span>';
      h += '<span class="pivot-cf-remove" data-cfidx="' + idx + '" title="Remove">&times;</span>';
      h += '</div>';

      h += '<div class="pivot-cf-detail" style="display:none">';
      // Type selector
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Type</label>';
      h += '<select class="pivot-cfg-select pivot-cf-field-type" data-cfidx="' + idx + '">';
      h += '<option value="threshold"' + (!isGradient ? ' selected' : '') + '>Threshold</option>';
      h += '<option value="gradient"' + (isGradient ? ' selected' : '') + '>Gradient</option>';
      h += '</select></div>';
      // Measure selector
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Measure</label>';
      h += '<select class="pivot-cfg-select pivot-cf-field-measureId" data-cfidx="' + idx + '">';
      if (!isGradient) h += '<option value="all"' + (rule.measureId === 'all' ? ' selected' : '') + '>All measures</option>';
      for (var mi2 = 0; mi2 < measures.length; mi2++) {
        var mm = measures[mi2];
        var reg2 = AGG_REGISTRY[mm.aggregator] || { label: mm.aggregator };
        var label2 = mm.label || (reg2.label + (mm.field ? '(' + mm.field + ')' : ''));
        h += '<option value="' + esc(mm.id) + '"' + (rule.measureId === mm.id ? ' selected' : '') + '>' + esc(label2) + '</option>';
      }
      h += '</select></div>';

      if (!isGradient) {
        // Operator
        h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Operator</label>';
        h += '<select class="pivot-cfg-select pivot-cf-field-operator" data-cfidx="' + idx + '">';
        var ops = [['>', '> greater than'], ['<', '< less than'], ['>=', '≥ greater or equal'], ['<=', '≤ less or equal'], ['=', '= equals'], ['between', 'between']];
        for (var oi = 0; oi < ops.length; oi++) {
          h += '<option value="' + ops[oi][0] + '"' + (rule.operator === ops[oi][0] ? ' selected' : '') + '>' + ops[oi][1] + '</option>';
        }
        h += '</select></div>';
        // Value 1
        h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Value</label>';
        h += '<input type="number" class="pivot-cfg-input pivot-cf-field-value1" data-cfidx="' + idx + '" value="' + esc(rule.value1 !== undefined ? rule.value1 : '') + '" step="any"/>';
        h += '</div>';
        // Value 2 (between only)
        h += '<div class="pivot-prop-row pivot-cf-row-value2"' + (rule.operator === 'between' ? '' : ' style="display:none"') + '>';
        h += '<label class="pivot-prop-label">And</label>';
        h += '<input type="number" class="pivot-cfg-input pivot-cf-field-value2" data-cfidx="' + idx + '" value="' + esc(rule.value2 !== undefined ? rule.value2 : '') + '" step="any"/>';
        h += '</div>';
        // Color preset swatches (bg + text)
        h += '<div class="pivot-prop-row pivot-prop-row-stack"><label class="pivot-prop-label">Color</label>';
        h += '<div class="pivot-cf-swatches" data-cfidx="' + idx + '">';
        var curBg = (rule.bgColor || '#D1FAE5').toUpperCase();
        for (var pi = 0; pi < CF_COLOR_PRESETS.length; pi++) {
          var p = CF_COLOR_PRESETS[pi];
          var active = p.bg.toUpperCase() === curBg;
          h += '<button type="button" class="pivot-cf-swatch' + (active ? ' active' : '') +
               '" title="' + esc(p.name) + '" data-bg="' + esc(p.bg) + '" data-text="' + esc(p.text) +
               '" style="background:' + esc(p.bg) + ';color:' + esc(p.text) + '">' + esc(p.name[0]) + '</button>';
        }
        h += '</div></div>';
      } else {
        // Gradient preset swatches
        h += '<div class="pivot-prop-row pivot-prop-row-stack"><label class="pivot-prop-label">Gradient</label>';
        h += '<div class="pivot-cf-gradients" data-cfidx="' + idx + '">';
        var curMin = (rule.minColor || '#FFFFFF').toUpperCase();
        var curMax = (rule.maxColor || '#22C55E').toUpperCase();
        for (var gi = 0; gi < CF_GRADIENT_PRESETS.length; gi++) {
          var g = CF_GRADIENT_PRESETS[gi];
          var gActive = g.min.toUpperCase() === curMin && g.max.toUpperCase() === curMax;
          h += '<button type="button" class="pivot-cf-gradient-swatch' + (gActive ? ' active' : '') +
               '" title="' + esc(g.name) + '" data-min="' + esc(g.min) + '" data-max="' + esc(g.max) +
               '" style="background:linear-gradient(90deg,' + esc(g.min) + ',' + esc(g.max) + ')"></button>';
        }
        h += '</div></div>';
      }
      // Apply to totals
      h += '<div class="pivot-prop-row"><label class="pivot-prop-label">Apply to totals</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cf-field-applyToTotals" data-cfidx="' + idx + '"' + (rule.applyToTotals ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '</div>'; // end detail
      h += '</div>';
      return h;
    }

    // Build a formatting row: label | [align buttons] [B] [I] [U]
    function buildFormatRow(label, suffix, config) {
      var alignKey = 'align' + suffix;
      var styleKey = 'style' + suffix;
      var currentAlign = config[alignKey] || (suffix === 'RowFields' ? 'left' : 'right');
      var currentStyle = config[styleKey] || '';

      var h = '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">' + esc(label) + '</label>';
      h += '<div class="pivot-format-group">';

      // Alignment buttons
      h += '<div class="pivot-align-group" data-key="' + alignKey + '">';
      var aligns = ['left', 'center', 'right'];
      for (var i = 0; i < aligns.length; i++) {
        var val = aligns[i];
        var active = val === currentAlign ? ' active' : '';
        h += '<button type="button" class="pivot-align-btn' + active + '" data-align="' + val + '" data-key="' + alignKey + '" title="' + val + '">';
        h += '<span style="text-align:' + val + ';display:block;width:14px;font-size:9px;line-height:1.1">';
        h += '<span style="display:block;width:' + (val === 'right' ? '14' : val === 'center' ? '10' : '12') + 'px;height:2px;background:currentColor;margin:1px ' + (val === 'right' ? '0 1px auto' : val === 'center' ? 'auto' : '0') + '"></span>';
        h += '<span style="display:block;width:' + (val === 'right' ? '10' : val === 'center' ? '14' : '8') + 'px;height:2px;background:currentColor;margin:1px ' + (val === 'right' ? '0 1px auto' : val === 'center' ? 'auto' : '0') + '"></span>';
        h += '<span style="display:block;width:' + (val === 'right' ? '12' : val === 'center' ? '8' : '14') + 'px;height:2px;background:currentColor;margin:1px ' + (val === 'right' ? '0 1px auto' : val === 'center' ? 'auto' : '0') + '"></span>';
        h += '</span></button>';
      }
      h += '</div>';

      // Style buttons (Bold, Italic, Underline) — toggle on/off
      h += '<div class="pivot-style-group" data-key="' + styleKey + '">';
      var styles = [
        ['bold', '<strong>B</strong>'],
        ['italic', '<em>I</em>'],
        ['underline', '<span style="text-decoration:underline">U</span>'],
      ];
      for (var s = 0; s < styles.length; s++) {
        var sVal = styles[s][0];
        var sActive = currentStyle.indexOf(sVal) !== -1 ? ' active' : '';
        h += '<button type="button" class="pivot-style-btn' + sActive + '" data-style="' + sVal + '" data-key="' + styleKey + '" title="' + sVal + '">' + styles[s][1] + '</button>';
      }
      h += '</div>';

      h += '</div></div>';
      return h;
    }

    // Ordered picker: selected tags + dropdown to add
    function buildOrderedPicker(zone, selected) {
      var used = selected.slice(); // copy
      var h = '<div class="pivot-picker" data-zone="' + zone + '">';
      // Selected items as tags (in order)
      h += '<div class="pivot-picker-tags" data-zone="' + zone + '">';
      for (var i = 0; i < selected.length; i++) {
        h += '<span class="pivot-picker-tag">' + esc(selected[i]) +
          ' <span class="pivot-picker-tag-x" data-zone="' + zone + '" data-field="' + esc(selected[i]) + '">&times;</span></span>';
      }
      h += '</div>';
      // Dropdown to add (only shows unselected columns)
      h += '<select class="pivot-cfg-select pivot-picker-add" data-zone="' + zone + '">';
      h += '<option value="">+ Add field...</option>';
      for (var j = 0; j < cachedColumns.length; j++) {
        var c = cachedColumns[j];
        if (used.indexOf(c) === -1) {
          h += '<option value="' + esc(c) + '">' + esc(c) + '</option>';
        }
      }
      h += '</select>';
      h += '</div>';
      return h;
    }

    // ---- READ CONFIG FROM INJECTED DOM ----
    function readConfigFromDOM(section) {
      var config = defaultConfig();
      var enable = section.querySelector('.pivot-cfg-enable');
      if (enable) config.enabled = enable.checked;

      // Read ordered fields from configCache (tags are display only, source of truth is configCache)
      // But we need a fallback for first load
      var wn = activeWidget;
      if (wn && configCache[wn]) {
        config.rowFields = configCache[wn].rowFields.slice();
        config.colFields = configCache[wn].colFields.slice();
      }

      // --- Measures (source of truth: configCache, read DOM to capture edits) ---
      var cached = wn && configCache[wn];
      var baseMeasures = (cached && cached.measures) || config.measures || [{ id: _newMeasureId(), field: '', aggregator: 'count' }];
      // Read any DOM inputs for current measures and merge
      var measureRows = section.querySelectorAll('.pivot-measure-row');
      var newMeasures = [];
      for (var mi = 0; mi < measureRows.length; mi++) {
        var mr = measureRows[mi];
        var midx = parseInt(mr.getAttribute('data-midx'), 10);
        var base = baseMeasures[midx] || { id: _newMeasureId() };
        var aggEl = mr.querySelector('.pivot-measure-agg');
        var fieldEl = mr.querySelector('.pivot-measure-field');
        var pctEl = mr.querySelector('.pivot-measure-pct');
        var lblEl = mr.querySelector('.pivot-measure-lbl');
        var dpEl = mr.querySelector('.pivot-measure-dp');
        var nfEl = mr.querySelector('.pivot-measure-nf');
        var prefEl = mr.querySelector('.pivot-measure-prefix');
        var sufEl = mr.querySelector('.pivot-measure-suffix');
        var whereFEl = mr.querySelector('.pivot-measure-where-field');
        var whereOpEl = mr.querySelector('.pivot-measure-where-op');
        var whereVEl = mr.querySelector('.pivot-measure-where-val');
        var exprEl = mr.querySelector('.pivot-measure-expr');
        var m = {
          id: base.id || _newMeasureId(),
          aggregator: aggEl ? aggEl.value : (base.aggregator || 'count'),
          field: fieldEl ? fieldEl.value : (base.field || ''),
          label: lblEl ? lblEl.value : (base.label || ''),
          decimalPlaces: dpEl ? (dpEl.value === '' ? undefined : dpEl.value) : base.decimalPlaces,
          numberFormat: nfEl ? nfEl.value : base.numberFormat,
          prefix: prefEl ? prefEl.value : (base.prefix || ''),
          suffix: sufEl ? sufEl.value : (base.suffix || ''),
        };
        if (m.aggregator === 'percentile' && pctEl) m.percentile = parseFloat(pctEl.value) || 0.95;
        if (m.aggregator === 'sum-where' || m.aggregator === 'count-where') {
          m.where = {
            field: whereFEl ? whereFEl.value : (base.where && base.where.field) || '',
            op: whereOpEl ? whereOpEl.value : (base.where && base.where.op) || '=',
            value: whereVEl ? whereVEl.value : (base.where && base.where.value) || '',
          };
        }
        if (m.aggregator === 'expr' && exprEl) m.expression = exprEl.value;
        newMeasures.push(m);
      }
      if (newMeasures.length === 0) newMeasures = baseMeasures;
      config.measures = newMeasures;
      config.valueField = newMeasures[0].field || '';
      config.aggregator = newMeasures[0].aggregator || 'count';

      // --- Conditional Formatting rules ---
      var baseCF = (cached && cached.conditionalFormats) || [];
      var cfRowsDom = section.querySelectorAll('.pivot-cf-row');
      var newCF = [];
      for (var ci = 0; ci < cfRowsDom.length; ci++) {
        var cr = cfRowsDom[ci];
        var cidx = parseInt(cr.getAttribute('data-cfidx'), 10);
        var cbase = baseCF[cidx] || { id: cr.getAttribute('data-cfid') || ('cf_' + Math.random().toString(36).slice(2, 10)) };
        var typeEl = cr.querySelector('.pivot-cf-field-type');
        var mIdEl = cr.querySelector('.pivot-cf-field-measureId');
        var opEl = cr.querySelector('.pivot-cf-field-operator');
        var v1El = cr.querySelector('.pivot-cf-field-value1');
        var v2El = cr.querySelector('.pivot-cf-field-value2');
        var activeSwatch = cr.querySelector('.pivot-cf-swatch.active');
        var activeGrad = cr.querySelector('.pivot-cf-gradient-swatch.active');
        var totEl = cr.querySelector('.pivot-cf-field-applyToTotals');
        var rule = {
          id: cbase.id,
          type: typeEl ? typeEl.value : (cbase.type || 'threshold'),
          measureId: mIdEl ? mIdEl.value : (cbase.measureId || 'all'),
          applyToTotals: totEl ? totEl.checked : !!cbase.applyToTotals,
        };
        if (rule.type === 'threshold') {
          rule.operator = opEl ? opEl.value : (cbase.operator || '>');
          rule.value1 = v1El && v1El.value !== '' ? parseFloat(v1El.value) : (cbase.value1 !== undefined ? cbase.value1 : 0);
          if (rule.operator === 'between') rule.value2 = v2El && v2El.value !== '' ? parseFloat(v2El.value) : (cbase.value2 !== undefined ? cbase.value2 : 0);
          rule.bgColor = activeSwatch ? activeSwatch.getAttribute('data-bg') : (cbase.bgColor || '#D1FAE5');
          rule.textColor = activeSwatch ? activeSwatch.getAttribute('data-text') : (cbase.textColor || '#065F46');
        } else {
          rule.minColor = activeGrad ? activeGrad.getAttribute('data-min') : (cbase.minColor || '#FFFFFF');
          rule.maxColor = activeGrad ? activeGrad.getAttribute('data-max') : (cbase.maxColor || '#22C55E');
        }
        newCF.push(rule);
      }
      config.conditionalFormats = newCF.length ? newCF : baseCF;

      var showTitleCb = section.querySelector('.pivot-cfg-showTitle');
      if (showTitleCb) config.showTitle = showTitleCb.checked;

      var titleAliasInp = section.querySelector('.pivot-cfg-titleAlias');
      if (titleAliasInp) config.titleAlias = titleAliasInp.value;

      var showRowTotal = section.querySelector('.pivot-cfg-showRowTotal');
      if (showRowTotal) config.showRowTotal = showRowTotal.checked;
      var rowTotalInp = section.querySelector('.pivot-cfg-rowTotalLabel');
      if (rowTotalInp) config.rowTotalLabel = rowTotalInp.value || 'Total';

      var showGrandTotal = section.querySelector('.pivot-cfg-showGrandTotal');
      if (showGrandTotal) config.showGrandTotal = showGrandTotal.checked;
      var grandInp = section.querySelector('.pivot-cfg-grandTotalLabel');
      if (grandInp) config.grandTotalLabel = grandInp.value || 'Grand Total';

      var showSubtotal = section.querySelector('.pivot-cfg-showSubtotal');
      if (showSubtotal) config.showSubtotal = showSubtotal.checked;
      var subtotalInp = section.querySelector('.pivot-cfg-subtotalLabel');
      if (subtotalInp) config.subtotalLabel = subtotalInp.value || '{group} Subtotal';


      var backendCb = section.querySelector('.pivot-cfg-backendPivot');
      if (backendCb) config.backendPivot = backendCb.checked;

      var emptySel = section.querySelector('.pivot-cfg-emptyValue');
      if (emptySel) config.emptyValue = emptySel.value;

      var dpSel = section.querySelector('.pivot-cfg-decimalPlaces');
      if (dpSel) config.decimalPlaces = dpSel.value === 'auto' ? 'auto' : dpSel.value;

      var pageSizeSel = section.querySelector('.pivot-cfg-pageSize');
      if (pageSizeSel) config.pageSize = parseInt(pageSizeSel.value, 10) || 0;

      // Read alignment from active buttons
      var alignKeys = ['alignRowFields', 'alignColValues', 'alignRowTotal', 'alignGrandTotal', 'alignSubtotal'];
      for (var ai = 0; ai < alignKeys.length; ai++) {
        var activeBtn = section.querySelector('.pivot-align-btn.active[data-key="' + alignKeys[ai] + '"]');
        if (activeBtn) config[alignKeys[ai]] = activeBtn.getAttribute('data-align');
      }

      // Read text styles from active style buttons
      var styleKeys = ['styleRowFields', 'styleColValues', 'styleRowTotal', 'styleGrandTotal', 'styleSubtotal'];
      for (var si = 0; si < styleKeys.length; si++) {
        var activeBtns = section.querySelectorAll('.pivot-style-btn.active[data-key="' + styleKeys[si] + '"]');
        var vals = [];
        for (var sb = 0; sb < activeBtns.length; sb++) vals.push(activeBtns[sb].getAttribute('data-style'));
        config[styleKeys[si]] = vals.join(' ');
      }

      return config;
    }

    // Rebuild just the picker UI for a zone (after add/remove)
    function rebuildPicker(section, zone, selected, widgetName) {
      var container = section.querySelector('.pivot-picker[data-zone="' + zone + '"]');
      if (!container) return;

      // Rebuild tags
      var tagsDiv = container.querySelector('.pivot-picker-tags');
      var th = '';
      for (var i = 0; i < selected.length; i++) {
        th += '<span class="pivot-picker-tag">' + esc(selected[i]) +
          ' <span class="pivot-picker-tag-x" data-zone="' + zone + '" data-field="' + esc(selected[i]) + '">&times;</span></span>';
      }
      tagsDiv.innerHTML = th;

      // Rebuild dropdown (only unselected)
      var sel = container.querySelector('.pivot-picker-add');
      var oh = '<option value="">+ Add field...</option>';
      for (var j = 0; j < cachedColumns.length; j++) {
        var c = cachedColumns[j];
        if (selected.indexOf(c) === -1) {
          oh += '<option value="' + esc(c) + '">' + esc(c) + '</option>';
        }
      }
      sel.innerHTML = oh;
    }

    // Rebuild the entire measures list UI (used after add/remove)
    function rebuildMeasuresUI(section, config) {
      var list = section.querySelector('.pivot-measures-list');
      if (!list) return;
      normalizeConfig(config);
      var h = '';
      for (var i = 0; i < config.measures.length; i++) {
        h += buildMeasureRow(config.measures[i], i, config);
      }
      list.innerHTML = h;
    }

    function rebuildCFUI(section, config) {
      var list = section.querySelector('.pivot-cf-list');
      if (!list) return;
      normalizeConfig(config);
      var h = '';
      var arr = config.conditionalFormats || [];
      for (var i = 0; i < arr.length; i++) {
        h += buildCFRow(arr[i], i, config);
      }
      list.innerHTML = h;
    }

    // Rebuild the Value Field dropdown (exclude fields used in Row/Column Fields)
    function rebuildValueFieldDropdown(section, config) {
      var valSel = section.querySelector('.pivot-cfg-valueField');
      if (!valSel) return;
      var used = (config.rowFields || []).concat(config.colFields || []);
      var currentVal = config.valueField || '';
      // If current valueField is now in row/col, clear it
      if (currentVal && used.indexOf(currentVal) !== -1) {
        currentVal = '';
        config.valueField = '';
      }
      var oh = '<option value="">(Count rows)</option>';
      for (var j = 0; j < cachedColumns.length; j++) {
        var c = cachedColumns[j];
        if (used.indexOf(c) !== -1) continue;
        oh += '<option value="' + esc(c) + '"' + (currentVal === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }
      valSel.innerHTML = oh;
    }

    // ---- BIND EVENTS ----
    var _debounceTimer = null;
    function bindEvents(section, widgetName) {
      function onConfigChange() {
        var config = readConfigFromDOM(section);
        setConfig(widgetName, config);
        console.log(LOG_PREFIX, 'Config saved for', widgetName, JSON.stringify(config));

        // Reset page when config changes
        setPivotPage(widgetName, 0);

        // Clear backend pivot cache so it re-fetches
        delete _backendPivotCache[widgetName];

        var fields = section.querySelector('.pivot-cfg-fields');
        if (fields) fields.style.display = config.enabled ? '' : 'none';

        // Hide/show other Table config sections
        applyTableOverrides(config.enabled);

        updatePreview(widgetName, config);
      }

      // Enable toggle + simple selects / checkboxes
      var simpleInputs = section.querySelectorAll('.pivot-cfg-enable, .pivot-cfg-showTitle, .pivot-cfg-showRowTotal, .pivot-cfg-showGrandTotal, .pivot-cfg-showSubtotal, .pivot-cfg-emptyValue, .pivot-cfg-decimalPlaces, .pivot-cfg-pageSize');
      for (var i = 0; i < simpleInputs.length; i++) {
        simpleInputs[i].addEventListener('change', onConfigChange);
      }

      // Measure controls: any change triggers onConfigChange + rebuild
      section.addEventListener('change', function (e) {
        var el = e.target;
        if (el.classList && el.classList.contains('pivot-measure-agg')) {
          // Aggregator change: show/hide field/percentile/where/expr rows
          var mr = el.closest('.pivot-measure-row');
          if (mr) {
            var needsField = el.value !== 'count' && el.value !== 'count-where' && el.value !== 'expr';
            var fr = mr.querySelector('.pivot-measure-field-row'); if (fr) fr.style.display = needsField ? '' : 'none';
            var pr = mr.querySelector('.pivot-measure-pct-row'); if (pr) pr.style.display = el.value === 'percentile' ? '' : 'none';
            var wr = mr.querySelector('.pivot-measure-where-row'); if (wr) wr.style.display = (el.value === 'sum-where' || el.value === 'count-where') ? '' : 'none';
            var er = mr.querySelector('.pivot-measure-expr-row'); if (er) er.style.display = el.value === 'expr' ? '' : 'none';
          }
          onConfigChange();
        } else if (el.classList && (el.classList.contains('pivot-measure-field') || el.classList.contains('pivot-measure-dp') ||
                                   el.classList.contains('pivot-measure-nf') || el.classList.contains('pivot-measure-where-field') ||
                                   el.classList.contains('pivot-measure-where-op'))) {
          onConfigChange();
        }
      });
      // Measure text inputs (debounced)
      section.addEventListener('input', function (e) {
        var el = e.target;
        if (el.classList && (el.classList.contains('pivot-measure-lbl') || el.classList.contains('pivot-measure-prefix') ||
                              el.classList.contains('pivot-measure-suffix') || el.classList.contains('pivot-measure-pct') ||
                              el.classList.contains('pivot-measure-where-val') || el.classList.contains('pivot-measure-expr'))) {
          clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(onConfigChange, 300);
        }
      });

      // Measure row actions (toggle, remove, add)
      section.addEventListener('click', function (e) {
        var tgl = e.target.closest('.pivot-measure-toggle, .pivot-measure-summary');
        if (tgl) {
          var mr = tgl.closest('.pivot-measure-row');
          if (mr && !e.target.closest('.pivot-measure-remove')) {
            var d = mr.querySelector('.pivot-measure-detail');
            if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
            e.stopPropagation();
          }
        }
        var rm = e.target.closest('.pivot-measure-remove');
        if (rm) {
          e.stopPropagation();
          var idx = parseInt(rm.getAttribute('data-midx'), 10);
          var cfg = getConfig(widgetName);
          if (cfg.measures && cfg.measures.length > 1) {
            cfg.measures.splice(idx, 1);
            setConfig(widgetName, cfg);
            rebuildMeasuresUI(section, cfg);
            updatePreview(widgetName, cfg);
          }
        }
        var add = e.target.closest('.pivot-add-measure-btn');
        if (add) {
          e.stopPropagation();
          var cfg2 = getConfig(widgetName);
          cfg2.measures = (cfg2.measures || []).concat([{ id: _newMeasureId(), field: '', aggregator: 'sum', label: '' }]);
          setConfig(widgetName, cfg2);
          rebuildMeasuresUI(section, cfg2);
          updatePreview(widgetName, cfg2);
        }

        // ---- Conditional Formatting actions ----
        var cfTgl = e.target.closest('.pivot-cf-toggle, .pivot-cf-summary');
        if (cfTgl) {
          var cr = cfTgl.closest('.pivot-cf-row');
          if (cr && !e.target.closest('.pivot-cf-remove')) {
            var cd = cr.querySelector('.pivot-cf-detail');
            if (cd) cd.style.display = cd.style.display === 'none' ? '' : 'none';
            e.stopPropagation();
          }
        }
        var cfRm = e.target.closest('.pivot-cf-remove');
        if (cfRm) {
          e.stopPropagation();
          var cIdx = parseInt(cfRm.getAttribute('data-cfidx'), 10);
          var cfgCF = getConfig(widgetName);
          cfgCF.conditionalFormats = cfgCF.conditionalFormats || [];
          cfgCF.conditionalFormats.splice(cIdx, 1);
          setConfig(widgetName, cfgCF);
          rebuildCFUI(section, cfgCF);
          updatePreview(widgetName, cfgCF);
        }
        var cfAdd = e.target.closest('.pivot-add-cf-btn');
        if (cfAdd) {
          e.stopPropagation();
          var cfgCF2 = getConfig(widgetName);
          cfgCF2.conditionalFormats = (cfgCF2.conditionalFormats || []).concat([{
            id: 'cf_' + Math.random().toString(36).slice(2, 10),
            type: 'threshold',
            measureId: 'all',
            operator: '>',
            value1: 0,
            bgColor: '#D1FAE5',
            textColor: '#065F46',
            applyToTotals: false,
          }]);
          setConfig(widgetName, cfgCF2);
          rebuildCFUI(section, cfgCF2);
          updatePreview(widgetName, cfgCF2);
        }

        // CF color swatch click → set active + save
        var swatch = e.target.closest('.pivot-cf-swatch, .pivot-cf-gradient-swatch');
        if (swatch) {
          e.stopPropagation();
          var container = swatch.parentElement;
          var siblings = container.querySelectorAll(swatch.classList.contains('pivot-cf-swatch') ? '.pivot-cf-swatch' : '.pivot-cf-gradient-swatch');
          for (var ss = 0; ss < siblings.length; ss++) siblings[ss].classList.remove('active');
          swatch.classList.add('active');
          var cfgSw = readConfigFromDOM(section);
          setConfig(widgetName, cfgSw);
          rebuildCFUI(section, cfgSw);
          updatePreview(widgetName, cfgSw);
        }
      });

      // CF: type/operator/measure selector changes → re-read + rebuild this row
      section.addEventListener('change', function (e) {
        var el = e.target;
        if (!el.classList) return;
        if (el.classList.contains('pivot-cf-field-type')
            || el.classList.contains('pivot-cf-field-measureId')
            || el.classList.contains('pivot-cf-field-operator')
            || el.classList.contains('pivot-cf-field-applyToTotals')) {
          // Read, apply, rebuild to reflect type/operator changes
          var cfg = readConfigFromDOM(section);
          setConfig(widgetName, cfg);
          rebuildCFUI(section, cfg);
          updatePreview(widgetName, cfg);
        }
      });
      // CF: value inputs (debounced)
      section.addEventListener('input', function (e) {
        var el = e.target;
        if (!el.classList) return;
        if (el.classList.contains('pivot-cf-field-value1') || el.classList.contains('pivot-cf-field-value2')) {
          clearTimeout(_debounceTimer);
          _debounceTimer = setTimeout(function () {
            var cfg = readConfigFromDOM(section);
            setConfig(widgetName, cfg);
            updatePreview(widgetName, cfg);
          }, 300);
        }
      });

      // Backend Pivot — auto-detect if datasource supports SQL
      var backendSection = section.querySelector('.pivot-backend-section');
      var backendCb = section.querySelector('.pivot-cfg-backendPivot');
      var backendInfo = section.querySelector('.pivot-backend-info');
      if (backendCb) {
        backendCb.addEventListener('change', onConfigChange);
      }
      var detVid = detectAppVersionId();
      console.log(LOG_PREFIX, 'Backend detect: versionId=', detVid, 'widget=', widgetName);
      if (detVid && backendSection) {
        apiFetch('/detect', {
          method: 'POST',
          body: JSON.stringify({ app_version_id: detVid, component_name: widgetName, component_id: _componentIdMap[widgetName] || undefined }),
        })
          .then(function (r) {
            console.log(LOG_PREFIX, 'Backend detect response status:', r.status);
            if (!r.ok) {
              r.clone().text().then(function (t) { console.log(LOG_PREFIX, 'Backend detect error body:', t); });
              return null;
            }
            return r.json();
          })
          .then(function (result) {
            console.log(LOG_PREFIX, 'Backend detect result:', JSON.stringify(result));
            if (!result) return;
            if (result.supported) {
              // Supported: force on, disable toggle (always use backend for SQL)
              if (backendCb) {
                backendCb.checked = true;
                backendCb.disabled = true;
              }
              if (backendInfo) backendInfo.textContent = 'Query: ' + (result.query_name || '?') + ' (' + result.kind + ')';
              var cfgOn = getConfig(widgetName);
              if (!cfgOn.backendPivot) {
                cfgOn.backendPivot = true;
                setConfig(widgetName, cfgOn);
                delete _backendPivotCache[widgetName];
                if (cfgOn.enabled) updatePreview(widgetName, cfgOn);
              }
            } else {
              // Not supported: disable toggle UI, show reason
              // Keep backendPivot: true in config — runtime fallback handles it
              // (backend execute fail → automatic frontend pivot fallback)
              if (backendCb) {
                backendCb.checked = false;
                backendCb.disabled = true;
              }
              if (backendInfo) backendInfo.textContent = result.reason || 'Not supported';
            }
          })
          .catch(function () {});
      }

      // Text inputs (labels) — debounced save on input, immediate on blur/Enter
      function onConfigChangeDebounced() {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(onConfigChange, 300);
      }
      var textInputs = section.querySelectorAll('.pivot-cfg-titleAlias, .pivot-cfg-rowTotalLabel, .pivot-cfg-grandTotalLabel, .pivot-cfg-subtotalLabel');
      for (var t = 0; t < textInputs.length; t++) {
        textInputs[t].addEventListener('input', onConfigChangeDebounced);
        textInputs[t].addEventListener('blur', function () { clearTimeout(_debounceTimer); onConfigChange(); });
        textInputs[t].addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounceTimer); onConfigChange(); }
        });
      }

      // Alignment buttons
      var alignBtns = section.querySelectorAll('.pivot-align-btn');
      for (var ab = 0; ab < alignBtns.length; ab++) {
        alignBtns[ab].addEventListener('click', function (e) {
          e.stopPropagation();
          var key = this.getAttribute('data-key');
          // Deactivate siblings in same group
          var group = section.querySelectorAll('.pivot-align-btn[data-key="' + key + '"]');
          for (var g = 0; g < group.length; g++) group[g].classList.remove('active');
          this.classList.add('active');
          onConfigChange();
        });
      }

      // Style buttons (toggle: click once = on, click again = off)
      var styleBtns = section.querySelectorAll('.pivot-style-btn');
      for (var sb = 0; sb < styleBtns.length; sb++) {
        styleBtns[sb].addEventListener('click', function (e) {
          e.stopPropagation();
          this.classList.toggle('active');
          onConfigChange();
        });
      }

      // Picker "Add field" dropdowns
      var addSelects = section.querySelectorAll('.pivot-picker-add');
      for (var a = 0; a < addSelects.length; a++) {
        addSelects[a].addEventListener('change', function () {
          var zone = this.getAttribute('data-zone');
          var val = this.value;
          if (!val) return;

          // Add to config
          var config = getConfig(widgetName);
          var arr = zone === 'rowFields' ? config.rowFields : config.colFields;
          if (arr.indexOf(val) === -1) arr.push(val);
          setConfig(widgetName, config);

          // Update UI
          rebuildPicker(section, zone, arr, widgetName);
          rebuildValueFieldDropdown(section, config);
          rebuildMeasuresUI(section, config);
          updatePreview(widgetName, config);
        });
      }

      // Tag remove buttons (delegated)
      section.addEventListener('click', function (e) {
        var xBtn = e.target.closest('.pivot-picker-tag-x');
        if (!xBtn) return;
        e.stopPropagation();

        var zone = xBtn.getAttribute('data-zone');
        var field = xBtn.getAttribute('data-field');

        var config = getConfig(widgetName);
        var arr = zone === 'rowFields' ? config.rowFields : config.colFields;
        var idx = arr.indexOf(field);
        if (idx !== -1) arr.splice(idx, 1);
        setConfig(widgetName, config);

        rebuildPicker(section, zone, arr, widgetName);
        rebuildValueFieldDropdown(section, config);
        updatePreview(widgetName, config);
      });

      // Refresh button
      var refreshBtn = section.querySelector('.pivot-refresh-btn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          refreshColumns(widgetName);
          console.log(LOG_PREFIX, 'Columns refreshed:', cachedColumns);
          forceReinject = true;
        });
      }
    }

    // ---- CANVAS PREVIEW ----
    function updatePreview(widgetName, config) {
      // Find the correct table element (match by component_id when multiple same-name exist)
      var tableEl = null;
      var candidates = document.querySelectorAll('[data-cy="draggable-widget-' + widgetName + '"]');
      if (candidates.length === 1) {
        tableEl = candidates[0];
      } else if (candidates.length > 1 && _activeComponentId) {
        for (var ci = 0; ci < candidates.length; ci++) {
          var cid = getComponentId(candidates[ci]);
          if (cid === _activeComponentId) { tableEl = candidates[ci]; break; }
        }
      }
      if (!tableEl && candidates.length > 0) tableEl = candidates[0];
      if (!tableEl) return;

      var dataArea = tableEl.querySelector('.jet-data-table');
      var footer = tableEl.querySelector('.jet-table-footer');
      var overlay = tableEl.querySelector('.pivot-overlay');

      if (config.enabled && (config.rowFields.length > 0 || config.colFields.length > 0)) {
        // Helper to render pivot data into overlay
        var renderIntoOverlay = function (data, serverTotal, serverGrandTotals, serverSubtotals) {
          var ov = tableEl.querySelector('.pivot-overlay');
          var da = tableEl.querySelector('.jet-data-table');
          var ft = tableEl.querySelector('.jet-table-footer');
          if (!ov) {
            ov = document.createElement('div');
            ov.className = 'pivot-overlay';
            if (da) da.parentNode.insertBefore(ov, da.nextSibling);
            else tableEl.appendChild(ov);
          }
          if (da) da.style.display = 'none';
          if (ft) ft.style.display = 'none';
          ov.style.display = 'flex';
          ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, widgetName, serverTotal, serverGrandTotals, serverSubtotals);
          ov._pivotData = data; ov._pivotServerTotal = serverTotal; ov._pivotServerGrandTotals = serverGrandTotals; ov._pivotServerSubtotals = serverSubtotals;
          bindDownloadButtons(ov, widgetName);
          bindPaginationButtons(ov, widgetName, data, config, tableEl, serverTotal);
          bindCollapseToggles(ov, widgetName, data, config, tableEl, serverTotal, serverGrandTotals);
          bindSortHeaders(ov, widgetName, data, config, tableEl, serverTotal);
          adjustPivotHeight(tableEl, ov);
        };

        var showOverlayMsg = function (msg, isError, isLoading) {
          var ov = tableEl.querySelector('.pivot-overlay');
          var da = tableEl.querySelector('.jet-data-table');
          if (!ov) {
            ov = document.createElement('div');
            ov.className = 'pivot-overlay';
            if (da) da.parentNode.insertBefore(ov, da.nextSibling);
            else tableEl.appendChild(ov);
          }
          if (da) da.style.display = 'none';
          ov.style.display = 'flex';
          if (isError) ov.innerHTML = buildTitleHTML(config) + buildErrorHTML(msg, { retry: false });
          else if (isLoading) ov.innerHTML = buildTitleHTML(config) + buildLoadingHTML(msg);
          else ov.innerHTML = buildTitleHTML(config) + '<div class="pivot-empty">' + esc(msg) + '</div>';
        };

        if (config.backendPivot) {
          // Backend pivot: call server API directly (no need for query to run on frontend)
          showOverlayMsg('Loading...', false, true);
          var bpPageSize = config.pageSize || 0;
          var bpPage = bpPageSize > 0 ? getPivotPage(widgetName) : 0;
          executePivotAsync(widgetName, config, function (err, rows, total, grandTotals, subtotals) {
            if (err) {
              // Fallback to frontend pivot with notification
              console.warn(LOG_PREFIX, 'Backend pivot failed, falling back to frontend:', err.message);
              showOverlayMsg('Backend pivot unavailable, using frontend...', false);
              extractDataAsync(tableEl, function (extracted) {
                if (extracted.data.length > 0) { renderIntoOverlay(extracted.data); }
                else { showOverlayMsg('No data available', false); }
              });
              return;
            }
            var data = reshapeBackendRows(rows, config);
            data._isBackend = true;
            renderIntoOverlay(data, total, grandTotals, subtotals);
          }, bpPage, bpPageSize);
        } else {
          // Frontend pivot: extract from DOM
          extractDataAsync(tableEl, function (extracted) {
            renderIntoOverlay(extracted.data);
          });
        }
      } else {
        if (dataArea) dataArea.style.display = '';
        if (footer) footer.style.display = '';
        if (overlay) { overlay.style.display = 'none'; overlay.innerHTML = ''; }
      }
    }

    function clearPreview(widgetName) {
      if (!widgetName) return;
      var tableEl = document.querySelector('[data-cy="draggable-widget-' + widgetName + '"]');
      if (!tableEl) return;
      var dataArea = tableEl.querySelector('.jet-data-table');
      var footer = tableEl.querySelector('.jet-table-footer');
      var overlay = tableEl.querySelector('.pivot-overlay');
      if (dataArea) dataArea.style.display = '';
      if (footer) footer.style.display = '';
      if (overlay) overlay.remove();
    }

    // ---- MAIN POLLING LOOP (500ms) — inspector + canvas overlay keeper combined ----
    var forceReinject = false;
    var _backendPivotCache = {}; // componentName -> { html, timestamp }
    var _backendPivotPending = {}; // componentName -> true (request in-flight)

    setInterval(function () {
      var isTable = isTableInspector();
      var widgetName = getWidgetName();
      var section = document.getElementById(SECTION_ID);

      // Case 1: Not a table or no widget selected → remove inspector section only
      if (!isTable || !widgetName) {

        if (section) section.remove();
        activeWidget = null;
        return;
      }

      // Detect current component UUID (even before widget change detection)
      var _curTableEl = document.querySelector('[data-cy="draggable-widget-' + widgetName + '"]');
      var _curCid = _curTableEl ? getComponentId(_curTableEl) : null;
      var componentChanged = _curCid && _activeComponentId && _curCid !== _activeComponentId;

      // Case 2: Different widget selected (or renamed, or same name on different page)
      if (widgetName !== activeWidget || componentChanged) {

        // Carry config from old name to new name if new name has no config (rename only, not page switch)
        var isRename = false;
        if (!componentChanged && activeWidget && configCache[activeWidget] && !configCache[widgetName]) {
          isRename = true;
          configCache[widgetName] = configCache[activeWidget];
          saveConfigLocal(widgetName, configCache[widgetName]);
          // Save to API (creates row with new name in DB)
          saveConfig(widgetName, configCache[widgetName], _componentIdMap[activeWidget] || _componentIdMap[widgetName]);
          // Retry after 2s + 5s (ToolJet DB name commit may lag)
          var _carryName = widgetName;
          var _carryCid = _componentIdMap[activeWidget] || _componentIdMap[widgetName];
          if (_componentIdMap[activeWidget]) _componentIdMap[widgetName] = _componentIdMap[activeWidget];
          setTimeout(function () { if (configCache[_carryName]) saveConfig(_carryName, configCache[_carryName], _carryCid); }, 2000);
          setTimeout(function () { if (configCache[_carryName]) saveConfig(_carryName, configCache[_carryName], _carryCid); }, 5000);
          console.log(LOG_PREFIX, 'Config carried:', activeWidget, '→', widgetName);
        }

        _previousWidget = activeWidget;
        if (section) section.remove();
        activeWidget = widgetName;
        _activeComponentId = _curCid;
        if (_curCid) _componentIdMap[widgetName] = _curCid;
        section = null;
        _configRetryCount = 0;
        refreshColumns(widgetName);
        console.log(LOG_PREFIX, 'Table selected:', widgetName, 'id:', _activeComponentId || 'N/A', 'columns:', cachedColumns);

        // On page switch (same name, different component), clear cached config to force reload
        if (componentChanged) {
          delete configCache[widgetName];
          console.log(LOG_PREFIX, 'Page switch detected, clearing config cache for', widgetName);
        }

        // Pre-fetch config from API (updates cache + localStorage, then re-inject)
        if (!configCache[widgetName] && !_configLoadPending) {
          _configLoadPending = true;
          _configRetryCount = 0;
          (function retryLoad(retryName) {
            loadConfigAsync(retryName, function (apiConfig) {
              // Abort if widget changed while loading
              if (activeWidget !== retryName) { _configLoadPending = false; return; }
              if (apiConfig) {
                _configLoadPending = false;
                _configRetryCount = 0;
                configCache[retryName] = apiConfig;
                forceReinject = true;
              } else if (_configRetryCount < 5) {
                // Retry: DB might not have updated the component name yet (rename)
                _configRetryCount++;
                console.log(LOG_PREFIX, 'Config not found for', retryName, '- retry', _configRetryCount);
                setTimeout(function () {
                  if (activeWidget === retryName && !configCache[retryName]) {
                    retryLoad(retryName);
                  } else {
                    _configLoadPending = false;
                  }
                }, 500);
              } else {
                _configLoadPending = false;
                _configRetryCount = 0;
              }
            });
          })(widgetName);
        } else if (isRename) {
          // Config already carried over from rename, force re-inject
          forceReinject = true;
        }
      }

      // Auto-detect column changes (datasource/query changed → table re-rendered with new headers)
      if (section && activeWidget) {
        var tableEl = document.querySelector('[data-cy="draggable-widget-' + activeWidget + '"]');
        if (tableEl) {
          var freshCols = extractColumns(tableEl);
          if (freshCols.length > 0 && JSON.stringify(freshCols) !== JSON.stringify(cachedColumns)) {
            console.log(LOG_PREFIX, 'Columns changed:', cachedColumns, '→', freshCols);
            cachedColumns = freshCols;
            delete dataCache[activeWidget]; // clear stale data cache
            forceReinject = true;
          }
        }
      }

      // Case 3: Config loading from API — wait before injecting to prevent overwrite
      if (_configLoadPending) return;

      // Case 4: Section exists and no force → skip
      if (section && !forceReinject) return;
      forceReinject = false;

      // Case 5: Inject the section
      var accordion = findAccordion();
      if (!accordion) return;

      if (section) section.remove();

      // getConfig: memory → localStorage → default
      var config = getConfig(widgetName);
      console.log(LOG_PREFIX, 'Injecting for', widgetName, JSON.stringify(config));
      var newSection = buildSection(config);
      accordion.appendChild(newSection);
      bindEvents(newSection, widgetName);

      // Show preview if enabled
      if (config.enabled) updatePreview(widgetName, config);

      // Hide other Table config sections when pivot is enabled
      applyTableOverrides(config.enabled);

      // ---- CANVAS OVERLAY KEEPER (inline, same loop) ----
      (function keepOverlays() {
      var tables = document.querySelectorAll('.jet-table.table-component');
      for (var i = 0; i < tables.length; i++) {
        (function (tableEl) {
          var name = getComponentName(tableEl);
          if (!name) return;

          // Only apply to the component that owns this config (match by component_id)
          var elCid = getComponentId(tableEl);
          var cachedCid = _componentIdMap[name];
          if (elCid && cachedCid && elCid !== cachedCid) return; // different component with same name, skip

          var config = configCache[name] || loadConfig(name);
          if (!config || !config.enabled) return;
          if (config.rowFields.length === 0 && config.colFields.length === 0) return;

          var overlay = tableEl.querySelector('.pivot-overlay');
          var dataArea = tableEl.querySelector('.jet-data-table');
          var footer = tableEl.querySelector('.jet-table-footer');

          // Ensure original table stays hidden
          if (dataArea && dataArea.style.display !== 'none') dataArea.style.display = 'none';
          if (footer && footer.style.display !== 'none') footer.style.display = 'none';

          // If overlay exists and visible, nothing to do
          if (overlay && overlay.style.display !== 'none' && overlay.innerHTML) return;

          // Need to create/restore overlay
          function ensureOverlay() {
            var ov = tableEl.querySelector('.pivot-overlay');
            if (!ov) {
              ov = document.createElement('div');
              ov.className = 'pivot-overlay';
              var da = tableEl.querySelector('.jet-data-table');
              if (da) da.parentNode.insertBefore(ov, da.nextSibling);
              else tableEl.appendChild(ov);
            }
            ov.style.display = 'flex';
            return ov;
          }

          if (config.backendPivot) {
            var kPageSize = config.pageSize || 0;
            var kPage = kPageSize > 0 ? getPivotPage(name) : 0;
            // Use cache if available (avoid repeated API calls / retry loops)
            // Cache is valid if timestamp is within CACHE_TTL (else fetch fresh)
            var cacheEntry = _backendPivotCache[name];
            var cacheFresh = cacheEntry && cacheEntry.timestamp && (Date.now() - cacheEntry.timestamp < CACHE_TTL);
            if (cacheEntry && !cacheFresh) { delete _backendPivotCache[name]; cacheEntry = null; }
            if (cacheEntry) {
              if (cacheEntry.failed) return; // failed before, don't retry (use frontend fallback)
              if (cacheEntry.data && !kPageSize) {
                var ov = ensureOverlay();
                ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(cacheEntry.data, config, name);
                ov._pivotData = cacheEntry.data;
                bindDownloadButtons(ov, name);
                bindPaginationButtons(ov, name, cacheEntry.data, config, tableEl);
                bindCollapseToggles(ov, name, cacheEntry.data, config, tableEl);
                bindSortHeaders(ov, name, cacheEntry.data, config, tableEl);
                return;
              }
            }
            // Fetch from backend (once, then cache)
            if (_backendPivotPending[name]) return; // already in-flight
            _backendPivotPending[name] = true;
            executePivotAsync(name, config, function (err, rows, total, grandTotals, subtotals) {
              _backendPivotPending[name] = false;
              if (err) {
                // Cache failure to prevent retry loop
                _backendPivotCache[name] = { failed: true, timestamp: Date.now() };
                console.warn(LOG_PREFIX, 'Backend pivot failed for', name, '- falling back to frontend:', err.message);
                // Fallback: try frontend pivot for keeper
                extractDataAsync(tableEl, function (extracted) {
                  if (extracted.data.length === 0) return;
                  var ov2 = ensureOverlay();
                  ov2.innerHTML = buildTitleHTML(config) + renderPivotHTML(extracted.data, config, name);
                  bindDownloadButtons(ov2, name);
                  bindPaginationButtons(ov2, name, extracted.data, config, tableEl);
                  bindSortHeaders(ov2, name, extracted.data, config, tableEl);
                });
                return;
              }
              var data = reshapeBackendRows(rows, config);
              data._isBackend = true;
              if (!kPageSize) _backendPivotCache[name] = { data: data, timestamp: Date.now() };
              var ov = ensureOverlay();
              ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, name, total, grandTotals, subtotals);
              ov._pivotData = data; ov._pivotServerTotal = total; ov._pivotServerGrandTotals = grandTotals;
              bindDownloadButtons(ov, name);
              bindPaginationButtons(ov, name, data, config, tableEl, total);
              bindCollapseToggles(ov, name, data, config, tableEl, total, grandTotals);
              bindSortHeaders(ov, name, data, config, tableEl, total);
            }, kPage, kPageSize);
          } else {
            // Frontend pivot: extract from DOM
            extractDataAsync(tableEl, function (extracted) {
              if (extracted.data.length === 0) return;
              var ov = ensureOverlay();
              ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(extracted.data, config, name);
              ov._pivotData = extracted.data;
              bindDownloadButtons(ov, name);
              bindPaginationButtons(ov, name, extracted.data, config, tableEl);
              bindCollapseToggles(ov, name, extracted.data, config, tableEl);
              bindSortHeaders(ov, name, extracted.data, config, tableEl);
            });
          }
        })(tables[i]);
      }
      })(); // end keepOverlays

    }, 500);
  }

  // =====================================================================
  //  VIEWER MODE
  // =====================================================================
  if (isViewer) {
    var processedSet = new WeakSet();
    var viewerConfigs = {}; // component_name -> config (loaded from API)
    var viewerConfigsLoaded = false;

    // Pre-fetch all configs from API (once appVersionId is captured)
    var configsLoadPending = false;
    function tryLoadViewerConfigs() {
      var vid = detectAppVersionId();
      if (viewerConfigsLoaded || configsLoadPending || !vid) return;
      configsLoadPending = true;
      loadAllConfigsAsync(function (configs) {
        viewerConfigs = configs || {};
        viewerConfigsLoaded = true;
        configsLoadPending = false;
        console.log(LOG_PREFIX, 'Viewer configs loaded:', Object.keys(viewerConfigs).length, 'components');
        // Re-scan tables now that configs are available
        processedSet = new WeakSet(); // reset so tables get re-processed
        scanTables();
      });
    }

    function applyPivot(tableEl) {
      if (processedSet.has(tableEl)) return;

      var name = getComponentName(tableEl);
      if (!name) return;

      // Try matching by component_id first (multi-page safe), then by name
      var cid = getComponentId(tableEl);
      if (cid) _componentIdMap[name] = cid;
      var config = null;
      if (cid && viewerConfigs[name + '__' + cid.substring(0, 8)]) {
        config = viewerConfigs[name + '__' + cid.substring(0, 8)];
      }
      if (!config) config = viewerConfigs[name] || loadConfigLocal(name);
      if (!config || !config.enabled) {
        // Only mark as processed if configs are already loaded (avoid premature skip)
        if (viewerConfigsLoaded) processedSet.add(tableEl);
        return;
      }
      if (config.rowFields.length === 0 && config.colFields.length === 0) {
        if (viewerConfigsLoaded) processedSet.add(tableEl);
        return;
      }

      processedSet.add(tableEl);
      console.log(LOG_PREFIX, 'Applying pivot to', name, 'backendPivot:', !!config.backendPivot);

      function renderPivot(data, serverTotal, serverGrandTotals, serverSubtotals) {
        var dataArea = tableEl.querySelector('.jet-data-table');
        var footer = tableEl.querySelector('.jet-table-footer');
        if (dataArea) dataArea.style.display = 'none';
        if (footer) footer.style.display = 'none';

        var overlay = tableEl.querySelector('.pivot-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'pivot-overlay';
          if (dataArea) dataArea.parentNode.insertBefore(overlay, dataArea.nextSibling);
          else tableEl.appendChild(overlay);
        }

        overlay.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, name, serverTotal, serverGrandTotals, serverSubtotals);
        overlay.style.display = 'flex';
        overlay._pivotData = data; overlay._pivotServerTotal = serverTotal; overlay._pivotServerGrandTotals = serverGrandTotals; overlay._pivotServerSubtotals = serverSubtotals;
        bindDownloadButtons(overlay, name);
        bindPaginationButtons(overlay, name, data, config, tableEl, serverTotal);
        bindCollapseToggles(overlay, name, data, config, tableEl, serverTotal, serverGrandTotals);
        bindSortHeaders(overlay, name, data, config, tableEl, serverTotal);
        adjustPivotHeight(tableEl, overlay);
      }

      function showLoading() {
        var dataArea = tableEl.querySelector('.jet-data-table');
        if (dataArea) dataArea.style.display = 'none';
        var overlay = tableEl.querySelector('.pivot-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'pivot-overlay';
          if (dataArea) dataArea.parentNode.insertBefore(overlay, dataArea.nextSibling);
          else tableEl.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        overlay.innerHTML = buildTitleHTML(config) + buildLoadingHTML('Loading...');
      }

      function showError(msg, retryFn) {
        var overlay = tableEl.querySelector('.pivot-overlay');
        if (overlay) showErrorInOverlay(overlay, config, msg, retryFn);
      }

      // ---- Backend Pivot: call server API directly ----
      if (config.backendPivot) {
        showLoading();

        var vPageSize = config.pageSize || 0;
        var vPage = vPageSize > 0 ? getPivotPage(name) : 0;

        // Retry backend pivot (version ID might not be captured yet in viewer)
        var backendAttempts = 0;
        var maxBackendAttempts = 10;
        function tryBackendPivot() {
          backendAttempts++;
          var vid = detectAppVersionId();
          if (!vid && backendAttempts < maxBackendAttempts) {
            setTimeout(tryBackendPivot, 1000);
            return;
          }
          executePivotAsync(name, config, function (err, rows, total, grandTotals, subtotals) {
            if (err) {
              if (backendAttempts < maxBackendAttempts && err.message && err.message.indexOf('version not detected') !== -1) {
                setTimeout(tryBackendPivot, 1000);
                return;
              }
              console.warn(LOG_PREFIX, 'Backend pivot failed:', err.message);
              // Fallback: try frontend pivot sources
              var fallbackData = getDataForPivot();
              if (fallbackData.length > 0) {
                renderPivot(fallbackData);
              } else {
                showError('No data available');
              }
              return;
            }
          // Reshape: backend rows → pivot-consumable data (handles multi-measure _pivot_m_<i>)
          var data = reshapeBackendRows(rows, config);
          data._isBackend = true;
          console.log(LOG_PREFIX, 'Backend pivot rendered:', name, data.length, 'rows', 'total:', total);
          renderPivot(data, total, grandTotals, subtotals);
          }, vPage, vPageSize);
        }
        tryBackendPivot();
        return;
      }

      // ---- Frontend Pivot: extract from DOM / intercepted API data ----
      function getDataForPivot() {
        var extracted = extractData(tableEl);
        if (extracted.data.length > 0) return extracted.data;

        var cacheKeys = Object.keys(_queryDataCache);
        for (var qi = 0; qi < cacheKeys.length; qi++) {
          var qData = _queryDataCache[cacheKeys[qi]];
          if (qData && qData.length > 0) {
            var dataKeys = Object.keys(qData[0]);
            var needed = config.rowFields.concat(config.colFields);
            if (config.valueField) needed.push(config.valueField);
            var match = needed.every(function (f) { return dataKeys.indexOf(f) !== -1; });
            if (match) {
              console.log(LOG_PREFIX, 'Using cached API data for', name, ':', qData.length, 'rows');
              return qData;
            }
          }
        }
        return [];
      }

      function tryRender() {
        var data = getDataForPivot();
        if (data.length === 0) return false;
        renderPivot(data);
        return true;
      }

      if (tryRender()) return;

      var attempts = 0;
      var maxAttempts = 60;
      var timer = setInterval(function () {
        attempts++;
        if (tryRender() || attempts >= maxAttempts) {
          if (attempts >= maxAttempts) console.warn(LOG_PREFIX, 'Timeout waiting for data for', name);
          clearInterval(timer);
        }
      }, 500);
    }

    function scanTables() {
      tryLoadViewerConfigs(); // attempt to load from API each scan until successful
      var tables = document.querySelectorAll('.jet-table.table-component');
      for (var i = 0; i < tables.length; i++) {
        applyPivot(tables[i]);
      }
    }

    // Poll for tables (handles dynamic loading)
    setInterval(scanTables, 1000);

    // Initial scan
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scanTables);
    } else {
      scanTables();
    }
  }
})();
