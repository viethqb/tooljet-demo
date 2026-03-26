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
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s ?? '');
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

  // localStorage fallback
  function storageKey(name) {
    return 'pivot__' + appSlug + '__' + name;
  }

  function saveConfigLocal(name, config) {
    try { localStorage.setItem(storageKey(name), JSON.stringify(config)); } catch (_) {}
  }

  function loadConfigLocal(name) {
    try {
      var raw = localStorage.getItem(storageKey(name));
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  // Save to API (fire-and-forget) + localStorage backup
  function saveConfig(name, config) {
    saveConfigLocal(name, config);
    var vid = detectAppVersionId();
    if (!vid) return;
    apiFetch('', {
      method: 'PUT',
      body: JSON.stringify({ app_version_id: vid, component_name: name, config: config }),
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
    apiFetch('/' + vid + '/' + encodeURIComponent(name))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.config) {
          saveConfigLocal(name, data.config); // sync localStorage
          callback(data.config);
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
  function loadAllConfigsAsync(callback) {
    var vid = detectAppVersionId();
    if (!vid) { callback({}); return; }
    apiFetch('/' + vid)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.configs) {
          // Sync all to localStorage
          var keys = Object.keys(data.configs);
          for (var i = 0; i < keys.length; i++) {
            saveConfigLocal(keys[i], data.configs[keys[i]]);
          }
          callback(data.configs);
        } else {
          callback({});
        }
      })
      .catch(function () { callback({}); });
  }

  // Execute backend pivot query (auto-detects query from component's data binding)
  function executePivotAsync(componentName, config, callback) {
    var vid = detectAppVersionId();
    if (!vid) { callback(new Error('App version not detected yet'), []); return; }
    apiFetch('/execute', {
      method: 'POST',
      body: JSON.stringify({ app_version_id: vid, component_name: componentName, config: config }),
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
      .then(function (result) { callback(null, result.data || []); })
      .catch(function (err) { callback(err, []); });
  }

  function defaultConfig() {
    return {
      enabled: false, rowFields: [], colFields: [], valueField: '', aggregator: 'count',
      showTitle: true, titleAlias: '',
      showRowTotal: true, rowTotalLabel: 'Total',
      showGrandTotal: true, grandTotalLabel: 'Grand Total',
      showSubtotal: false, subtotalLabel: 'Subtotal',
      backendPivot: false,
      alignRowFields: 'left', alignColValues: 'right', alignRowTotal: 'right',
      alignGrandTotal: 'right', alignSubtotal: 'right',
      styleRowFields: 'bold', styleColValues: '', styleRowTotal: '',
      styleGrandTotal: 'bold', styleSubtotal: 'bold italic',
      emptyValue: '-',
    };
  }

  // ===================== AGGREGATORS =====================
  const AGG = {
    count: { label: 'Count', fn: (v) => v.length },
    sum:   { label: 'Sum',   fn: (v) => v.reduce((a, b) => a + (parseFloat(b) || 0), 0) },
    avg:   { label: 'Avg',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? (n.reduce((a, b) => a + b, 0) / n.length).toFixed(2) : 0; } },
    min:   { label: 'Min',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? Math.min(...n) : ''; } },
    max:   { label: 'Max',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? Math.max(...n) : ''; } },
  };

  // ===================== DATA EXTRACTION + CACHE =====================
  // Cache per component name — survives display:none (virtualized table renders 0 rows when hidden)
  var dataCache = {}; // componentName -> { columns: [], data: [] }

  function getComponentName(tableEl) {
    var cy = tableEl.getAttribute('data-cy') || '';
    var m = cy.match(/^draggable-widget-(.+)$/);
    return m ? m[1] : null;
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
      if (name) dataCache[name] = result;
      return result;
    }

    // DOM returned empty — table likely hidden (virtualization). Use cache.
    if (name && dataCache[name] && dataCache[name].data.length > 0) {
      return dataCache[name];
    }

    // Fallback: temporarily show dataArea, extract, then re-hide
    var dataArea = tableEl.querySelector('.jet-data-table');
    if (dataArea && dataArea.style.display === 'none') {
      dataArea.style.display = '';
      // Force a layout reflow so virtualizer recalculates
      void dataArea.offsetHeight;
      // Wait a frame for virtual rows to render
      return { columns: result.columns, data: [], _pending: true, _name: name };
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
          dataCache[name] = result;
        }
        // Re-hide
        if (wasHidden && dataArea) dataArea.style.display = 'none';
        callback(result.data.length > 0 ? result : (name && dataCache[name]) ? dataCache[name] : result);
      }, 50);
    });
  }

  // ===================== PIVOT COMPUTATION =====================
  function computePivot(data, config) {
    var rowFields = config.rowFields;
    var colFields = config.colFields;
    var valueField = config.valueField;
    if (!data.length) return { tree: {}, colValues: [], rowKeys: [], rowFieldValues: {} };

    var colSet = new Set();
    var tree = {};
    var rowFieldValues = {}; // rowKey -> [val1, val2, ...]

    data.forEach(function (row) {
      var rowParts = rowFields.length ? rowFields.map(function (f) { return row[f] ?? '(empty)'; }) : ['(All)'];
      var rk = rowParts.join('\x00'); // use null byte as internal separator (never displayed)

      var colParts = colFields.length ? colFields.map(function (f) { return row[f] ?? '(empty)'; }) : ['(All)'];
      var ck = colParts.join('\x00');

      if (colFields.length) colSet.add(ck);
      if (!tree[rk]) { tree[rk] = { cells: {}, values: [] }; rowFieldValues[rk] = rowParts; }
      if (!tree[rk].cells[ck]) tree[rk].cells[ck] = [];

      var val = valueField ? row[valueField] : '1';
      tree[rk].cells[ck].push(val);
      tree[rk].values.push(val);
    });

    return {
      tree: tree,
      colValues: Array.from(colSet).sort(),
      rowKeys: Object.keys(tree).sort(),
      rowFieldValues: rowFieldValues,
    };
  }

  // ===================== TITLE BAR =====================
  function buildTitleHTML(config) {
    if (config.showTitle === false) return '';
    var title = config.titleAlias || '';
    if (!title) return '';
    return '<div class="pivot-title-bar">' +
      '<span class="pivot-title-text">' + esc(title) + '</span>' +
      '</div>';
  }

  // ===================== RENDER PIVOT HTML =====================
  function renderPivotHTML(data, config) {
    var result = computePivot(data, config);
    var tree = result.tree;
    var colValues = result.colValues;
    var rowKeys = result.rowKeys;
    var rowFieldValues = result.rowFieldValues;
    var aggFn = AGG[config.aggregator]?.fn || AGG.count.fn;

    if (rowKeys.length === 0) {
      return '<div class="pivot-empty">No data to pivot. Ensure the table has loaded data.</div>';
    }

    var rowFields = config.rowFields;
    var colFields = config.colFields;
    var showRowTotal = config.showRowTotal !== false;
    var rowTotalLabel = config.rowTotalLabel || 'Total';
    var showGrandTotal = config.showGrandTotal !== false;
    var grandTotalLabel = config.grandTotalLabel || 'Grand Total';
    var showSubtotal = config.showSubtotal && rowFields.length > 1;
    var subtotalLabel = config.subtotalLabel || 'Subtotal';
    var showCols = colValues.length > 0;
    var numRowCols = rowFields.length || 1;
    var numColFields = colFields.length || 0;

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

    // Build inline style from alignment + text style string
    function sf(align, style) {
      var css = 'text-align:' + align;
      css += ';font-weight:' + (style.indexOf('bold') !== -1 ? '600' : 'normal');
      css += ';font-style:' + (style.indexOf('italic') !== -1 ? 'italic' : 'normal');
      css += ';text-decoration:' + (style.indexOf('underline') !== -1 ? 'underline' : 'none');
      return ' style="' + css + '"';
    }

    // Split column key back to individual parts
    function colParts(ck) {
      return ck.split('\x00');
    }

    var h = '<div class="pivot-result-scroll"><table class="pivot-table"><thead>';

    if (showCols && numColFields > 1) {
      // ---- MULTI-LEVEL COLUMN HEADERS ----
      // Build hierarchical structure for column fields
      // Each level groups by the values at that depth

      for (var level = 0; level < numColFields; level++) {
        h += '<tr>';

        // Row field headers: only on last level row, with rowspan on first level
        if (level === 0) {
          for (var rf = 0; rf < (rowFields.length || 1); rf++) {
            h += '<th class="pivot-row-header" rowspan="' + numColFields + '">' +
              esc(rowFields.length > 0 ? rowFields[rf] : 'Row') + '</th>';
          }
        }

        // Group colValues by values at levels 0..level
        var groups = [];
        var lastGroupKey = null;
        for (var ci = 0; ci < colValues.length; ci++) {
          var parts = colParts(colValues[ci]);
          // Build group key from levels 0..level
          var groupKey = '';
          for (var gl = 0; gl <= level; gl++) {
            groupKey += (gl > 0 ? '\x00' : '') + parts[gl];
          }

          if (level < numColFields - 1) {
            // Non-leaf level: group by values up to this level
            var parentKey = '';
            for (var pl = 0; pl <= level; pl++) {
              parentKey += (pl > 0 ? '\x00' : '') + parts[pl];
            }
            if (parentKey !== lastGroupKey) {
              // Count how many colValues share this parentKey
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
              h += '<th class="pivot-col-header" colspan="' + span + '">' + esc(parts[level]) + '</th>';
              lastGroupKey = parentKey;
            }
          } else {
            // Leaf level: one header per colValue
            h += '<th class="pivot-col-header">' + esc(parts[level]) + '</th>';
          }
        }

        if (level === 0 && showRowTotal) {
          h += '<th class="pivot-total-header" rowspan="' + numColFields + '">' + esc(rowTotalLabel) + '</th>';
        }
        h += '</tr>';
      }

    } else {
      // ---- SINGLE-LEVEL HEADER (0 or 1 column field) ----
      h += '<tr>';
      if (rowFields.length > 0) {
        for (var rf2 = 0; rf2 < rowFields.length; rf2++) {
          h += '<th class="pivot-row-header">' + esc(rowFields[rf2]) + '</th>';
        }
      } else {
        h += '<th class="pivot-row-header">Row</th>';
      }
      if (showCols) {
        for (var ci2 = 0; ci2 < colValues.length; ci2++) {
          h += '<th class="pivot-col-header">' + esc(colParts(colValues[ci2]).join(' / ')) + '</th>';
        }
      }
      if (showRowTotal) h += '<th class="pivot-total-header">' + esc(rowTotalLabel) + '</th>';
      h += '</tr>';
    }

    h += '</thead><tbody>';

    // Group row keys by first field for subtotals
    var rowGroups = {};
    if (showSubtotal) {
      for (var gi2 = 0; gi2 < rowKeys.length; gi2++) {
        var firstField = (rowFieldValues[rowKeys[gi2]] || [''])[0];
        if (!rowGroups[firstField]) rowGroups[firstField] = [];
        rowGroups[firstField].push(rowKeys[gi2]);
      }
    }

    // Render helper for a single data row
    function renderRow(rk) {
      var rd = tree[rk];
      var parts = rowFieldValues[rk] || [rk];
      var r = '<tr class="pivot-row">';
      for (var rfi = 0; rfi < numRowCols; rfi++) {
        r += '<td class="pivot-row-label"' + sf(aRow, sRow) + '>' + esc(parts[rfi] ?? '') + '</td>';
      }
      if (showCols) {
        for (var cj = 0; cj < colValues.length; cj++) {
          var vals = rd.cells[colValues[cj]] || [];
          r += '<td class="pivot-cell"' + sf(aVal, sVal) + '>' + (vals.length ? aggFn(vals) : esc(emptyVal)) + '</td>';
        }
      }
      if (showRowTotal) r += '<td class="pivot-cell pivot-total-cell"' + sf(aRT, sRT) + '>' + aggFn(rd.values) + '</td>';
      r += '</tr>';
      return r;
    }

    // Render subtotal row for a group
    function renderSubtotalRow(groupKeys, groupLabel) {
      var r = '<tr class="pivot-subtotal">';
      r += '<td class="pivot-row-label" colspan="' + numRowCols + '"' + sf(aST, sST) + '>' + esc(subtotalLabel) + '</td>';
      if (showCols) {
        for (var sc = 0; sc < colValues.length; sc++) {
          var subVals = [];
          for (var sg = 0; sg < groupKeys.length; sg++) {
            var cv2 = tree[groupKeys[sg]].cells[colValues[sc]] || [];
            for (var sv = 0; sv < cv2.length; sv++) subVals.push(cv2[sv]);
          }
          r += '<td class="pivot-cell"' + sf(aST, sST) + '>' + aggFn(subVals) + '</td>';
        }
      }
      if (showRowTotal) {
        var subTotal = [];
        for (var st = 0; st < groupKeys.length; st++) {
          var stv = tree[groupKeys[st]].values;
          for (var st2 = 0; st2 < stv.length; st2++) subTotal.push(stv[st2]);
        }
        r += '<td class="pivot-cell pivot-total-cell"' + sf(aST, sST) + '>' + aggFn(subTotal) + '</td>';
      }
      r += '</tr>';
      return r;
    }

    // Data rows (with optional subtotals)
    if (showSubtotal) {
      var groupOrder = Object.keys(rowGroups).sort();
      for (var gIdx = 0; gIdx < groupOrder.length; gIdx++) {
        var gKey = groupOrder[gIdx];
        var gRows = rowGroups[gKey];
        for (var gri = 0; gri < gRows.length; gri++) {
          h += renderRow(gRows[gri]);
        }
        if (gRows.length > 1 || groupOrder.length > 1) {
          h += renderSubtotalRow(gRows, gKey);
        }
      }
    } else {
      for (var ri = 0; ri < rowKeys.length; ri++) {
        h += renderRow(rowKeys[ri]);
      }
    }

    // Grand total row
    if (showGrandTotal) {
      h += '<tr class="pivot-grand-total">';
      h += '<td class="pivot-row-label" colspan="' + numRowCols + '"' + sf(aGT, sGT) + '>' + esc(grandTotalLabel) + '</td>';
      if (showCols) {
        for (var ck = 0; ck < colValues.length; ck++) {
          var colTotal = [];
          for (var rri = 0; rri < rowKeys.length; rri++) {
            var cv = tree[rowKeys[rri]].cells[colValues[ck]] || [];
            for (var vi = 0; vi < cv.length; vi++) colTotal.push(cv[vi]);
          }
          h += '<td class="pivot-cell"' + sf(aGT, sGT) + '>' + aggFn(colTotal) + '</td>';
        }
      }
      if (showRowTotal) {
        var grandVals = [];
        for (var gvi = 0; gvi < rowKeys.length; gvi++) {
          var gv = tree[rowKeys[gvi]].values;
          for (var gvj = 0; gvj < gv.length; gvj++) grandVals.push(gv[gvj]);
        }
        h += '<td class="pivot-cell pivot-total-cell"' + sf(aGT, sGT) + '>' + aggFn(grandVals) + '</td>';
      }
      h += '</tr>';
    }

    h += '</tbody></table></div>';
    return h;
  }

  // =====================================================================
  //  EDITOR MODE
  // =====================================================================
  if (isEditor) {
    var SECTION_ID = 'pivot-inspector-section';
    var activeWidget = null;
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
      saveConfig(widgetName, config);
    }

    // Get currently selected widget name from Inspector
    function getWidgetName() {
      var input = document.querySelector('input[data-cy="edit-widget-name"]');
      return input ? input.value.trim() : null;
    }

    // Check if currently selected component is a Table (has "Data" accordion section)
    function isTableInspector() {
      return !!document.querySelector('[data-cy="widget-accordion-data"]');
    }

    // Find the .accordion container inside the Properties tab
    function findAccordion() {
      var dataSection = document.querySelector('[data-cy="widget-accordion-data"]');
      if (!dataSection) return null;
      var item = dataSection.closest('.accordion-item');
      if (!item) return null;
      return item.parentElement; // the .accordion div
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

      // Value Field
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Value Field</label>';
      h += '<select class="pivot-cfg-select pivot-cfg-valueField">';
      h += '<option value="">(Count rows)</option>';
      for (var i = 0; i < cachedColumns.length; i++) {
        var c = cachedColumns[i];
        h += '<option value="' + esc(c) + '"' + (config.valueField === c ? ' selected' : '') + '>' + esc(c) + '</option>';
      }
      h += '</select></div>';

      // Aggregation
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Aggregation</label>';
      h += '<select class="pivot-cfg-select pivot-cfg-aggregator">';
      var aggKeys = Object.keys(AGG);
      for (var j = 0; j < aggKeys.length; j++) {
        var k = aggKeys[j];
        h += '<option value="' + k + '"' + (config.aggregator === k ? ' selected' : '') + '>' + AGG[k].label + '</option>';
      }
      h += '</select></div>';

      // --- Backend Pivot section (auto-detected, hidden if not SQL datasource) ---
      h += '<div class="pivot-backend-section" style="display:none">';
      h += '<div class="pivot-section-label">Data Source</div>';
      h += '<div class="pivot-prop-row">';
      h += '<label class="pivot-prop-label">Backend Pivot</label>';
      h += '<label class="pivot-toggle-switch">';
      h += '<input type="checkbox" class="pivot-cfg-backendPivot"' + (config.backendPivot ? ' checked' : '') + '/>';
      h += '<span class="pivot-toggle-slider"></span>';
      h += '</label></div>';
      h += '<div class="pivot-backend-info pivot-hint"></div>';
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
      h += '<input type="text" class="pivot-cfg-input pivot-cfg-subtotalLabel" value="' + esc(config.subtotalLabel || 'Subtotal') + '" placeholder="Subtotal"/>';
      h += '</div>';

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
      h += buildFormatRow('Row Fields', 'RowFields', config);
      h += buildFormatRow('Values', 'ColValues', config);
      h += buildFormatRow('Row Total', 'RowTotal', config);
      h += buildFormatRow('Grand Total', 'GrandTotal', config);
      h += buildFormatRow('Subtotals', 'Subtotal', config);

      // Refresh columns button
      h += '<div class="pivot-prop-row">';
      h += '<button class="pivot-refresh-btn" type="button">Refresh Columns</button>';
      h += '</div>';

      h += '</div>'; // end pivot-cfg-fields
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

      var valSel = section.querySelector('.pivot-cfg-valueField');
      if (valSel) config.valueField = valSel.value;

      var aggSel = section.querySelector('.pivot-cfg-aggregator');
      if (aggSel) config.aggregator = aggSel.value;

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
      if (subtotalInp) config.subtotalLabel = subtotalInp.value || 'Subtotal';

      var backendCb = section.querySelector('.pivot-cfg-backendPivot');
      if (backendCb) config.backendPivot = backendCb.checked;

      var emptySel = section.querySelector('.pivot-cfg-emptyValue');
      if (emptySel) config.emptyValue = emptySel.value;

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

    // ---- BIND EVENTS ----
    function bindEvents(section, widgetName) {
      function onConfigChange() {
        var config = readConfigFromDOM(section);
        setConfig(widgetName, config);
        console.log(LOG_PREFIX, 'Config saved for', widgetName, JSON.stringify(config));

        // Clear backend pivot cache so it re-fetches
        delete _backendPivotCache[widgetName];

        var fields = section.querySelector('.pivot-cfg-fields');
        if (fields) fields.style.display = config.enabled ? '' : 'none';

        updatePreview(widgetName, config);
      }

      // Enable toggle + value field + aggregation
      var simpleInputs = section.querySelectorAll('.pivot-cfg-enable, .pivot-cfg-showTitle, .pivot-cfg-valueField, .pivot-cfg-aggregator, .pivot-cfg-showRowTotal, .pivot-cfg-showGrandTotal, .pivot-cfg-showSubtotal, .pivot-cfg-emptyValue');
      for (var i = 0; i < simpleInputs.length; i++) {
        simpleInputs[i].addEventListener('change', onConfigChange);
      }

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
          body: JSON.stringify({ app_version_id: detVid, component_name: widgetName }),
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
              backendSection.style.display = '';
              if (backendInfo) backendInfo.textContent = 'Query: ' + (result.query_name || '?') + ' (' + result.kind + ')';
            } else {
              backendSection.style.display = 'none';
              if (backendCb) backendCb.checked = false;
              if (backendInfo) backendInfo.textContent = result.reason || '';
            }
          })
          .catch(function () {});
      }

      // Text inputs (labels) — save on blur and Enter
      var textInputs = section.querySelectorAll('.pivot-cfg-titleAlias, .pivot-cfg-rowTotalLabel, .pivot-cfg-grandTotalLabel, .pivot-cfg-subtotalLabel');
      for (var t = 0; t < textInputs.length; t++) {
        textInputs[t].addEventListener('blur', onConfigChange);
        textInputs[t].addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); onConfigChange(); }
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
      var tableEl = document.querySelector('[data-cy="draggable-widget-' + widgetName + '"]');
      if (!tableEl) return;

      var dataArea = tableEl.querySelector('.jet-data-table');
      var footer = tableEl.querySelector('.jet-table-footer');
      var overlay = tableEl.querySelector('.pivot-overlay');

      if (config.enabled && (config.rowFields.length > 0 || config.colFields.length > 0)) {
        // Helper to render pivot data into overlay
        var renderIntoOverlay = function (data) {
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
          ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config);
        };

        var showOverlayMsg = function (msg, isError) {
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
          ov.innerHTML = '<div class="pivot-empty"' + (isError ? ' style="color:#e5484d"' : '') + '>' + esc(msg) + '</div>';
        };

        if (config.backendPivot) {
          // Backend pivot: call server API directly (no need for query to run on frontend)
          showOverlayMsg('Loading pivot data from server...');
          executePivotAsync(widgetName, config, function (err, rows) {
            if (err) {
              // Fallback to frontend pivot silently
              console.warn(LOG_PREFIX, 'Backend pivot failed, falling back to frontend:', err.message);
              extractDataAsync(tableEl, function (extracted) {
                if (extracted.data.length > 0) { renderIntoOverlay(extracted.data); }
                else { showOverlayMsg('No data available', false); }
              });
              return;
            }
            var data = rows.map(function (row) {
              var r = {};
              for (var k in row) {
                if (k === '_pivot_value' || k === '_pivot_count') continue;
                r[k] = row[k];
              }
              r[config.valueField || '_count'] = row['_pivot_value'];
              return r;
            });
            renderIntoOverlay(data);
          });
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

    // ---- MAIN POLLING LOOP (500ms) ----
    var forceReinject = false;

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

      // Case 2: Different widget selected
      if (widgetName !== activeWidget) {

        if (section) section.remove();
        activeWidget = widgetName;
        section = null;
        refreshColumns(widgetName);
        console.log(LOG_PREFIX, 'Table selected:', widgetName, 'columns:', cachedColumns);

        // Pre-fetch config from API (updates cache + localStorage, then re-inject)
        if (!configCache[widgetName]) {
          loadConfigAsync(widgetName, function (apiConfig) {
            if (apiConfig) {
              configCache[widgetName] = apiConfig;
              forceReinject = true; // trigger re-inject with API data
            }
          });
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

      // Case 3: Section exists and no force → skip
      if (section && !forceReinject) return;
      forceReinject = false;

      // Case 4: Inject the section
      var accordion = findAccordion();
      if (!accordion) return;

      if (section) section.remove();

      // getConfig: memory → localStorage → default (never loses data)
      var config = getConfig(widgetName);
      console.log(LOG_PREFIX, 'Injecting for', widgetName, JSON.stringify(config));
      var newSection = buildSection(config);
      accordion.appendChild(newSection);
      bindEvents(newSection, widgetName);

      // Show preview if enabled
      if (config.enabled) updatePreview(widgetName, config);

    }, 500);

    // ---- CANVAS OVERLAY KEEPER ----
    // Keeps pivot overlays alive when React re-renders canvas.
    // For backend pivot: caches result to avoid repeated API calls.
    var _backendPivotCache = {}; // componentName -> { html, timestamp }
    var _backendPivotPending = {}; // componentName -> true (request in-flight)

    setInterval(function () {
      var tables = document.querySelectorAll('.jet-table.table-component');
      for (var i = 0; i < tables.length; i++) {
        (function (tableEl) {
          var name = getComponentName(tableEl);
          if (!name) return;

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
            // Use cached HTML if available (avoid repeated API calls)
            if (_backendPivotCache[name]) {
              var ov = ensureOverlay();
              ov.innerHTML = _backendPivotCache[name].html;
              return;
            }
            // Fetch from backend (once, then cache)
            if (_backendPivotPending[name]) return; // already in-flight
            _backendPivotPending[name] = true;
            executePivotAsync(name, config, function (err, rows) {
              _backendPivotPending[name] = false;
              if (err) {
                // Fallback: try frontend pivot for keeper
                extractDataAsync(tableEl, function (extracted) {
                  if (extracted.data.length === 0) return;
                  var ov2 = ensureOverlay();
                  ov2.innerHTML = buildTitleHTML(config) + renderPivotHTML(extracted.data, config);
                });
                return;
              }
              var data = rows.map(function (row) {
                var r = {};
                for (var k in row) {
                  if (k === '_pivot_value' || k === '_pivot_count') continue;
                  r[k] = row[k];
                }
                r[config.valueField || '_count'] = row['_pivot_value'];
                return r;
              });
              var html = buildTitleHTML(config) + renderPivotHTML(data, config);
              _backendPivotCache[name] = { html: html, timestamp: Date.now() };
              var ov = ensureOverlay();
              ov.innerHTML = html;
            });
          } else {
            // Frontend pivot: extract from DOM
            extractDataAsync(tableEl, function (extracted) {
              if (extracted.data.length === 0) return;
              var ov = ensureOverlay();
              ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(extracted.data, config);
            });
          }
        })(tables[i]);
      }
    }, 800);
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

      // Try API config first, then localStorage fallback
      var config = viewerConfigs[name] || loadConfigLocal(name);
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

      function renderPivot(data) {
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

        overlay.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config);
        overlay.style.display = 'flex';
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
        overlay.innerHTML = '<div class="pivot-empty">Loading pivot data...</div>';
      }

      function showError(msg) {
        var overlay = tableEl.querySelector('.pivot-overlay');
        if (overlay) overlay.innerHTML = '<div class="pivot-empty" style="color:#e5484d">' + esc(msg) + '</div>';
      }

      // ---- Backend Pivot: call server API directly ----
      if (config.backendPivot) {
        showLoading();
        executePivotAsync(name, config, function (err, rows) {
          if (err) {
            // Fallback: try frontend pivot sources
            console.warn(LOG_PREFIX, 'Backend pivot failed, falling back to frontend:', err.message);
            var fallbackData = getDataForPivot();
            if (fallbackData.length > 0) {
              renderPivot(fallbackData);
            } else {
              showError('No data available. Query may have been deleted.');
            }
            return;
          }
          // Reshape: backend returns flat GROUP BY rows with _pivot_value
          var data = rows.map(function (row) {
            var r = {};
            for (var k in row) {
              if (k === '_pivot_value' || k === '_pivot_count') continue;
              r[k] = row[k];
            }
            r[config.valueField || '_count'] = row['_pivot_value'];
            return r;
          });
          console.log(LOG_PREFIX, 'Backend pivot rendered:', name, data.length, 'rows');
          renderPivot(data);
        });
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
