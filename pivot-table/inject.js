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
  // page/pageSize are optional — if provided, backend adds LIMIT/OFFSET
  function executePivotAsync(componentName, config, callback, page, pageSize) {
    var vid = detectAppVersionId();
    if (!vid) { callback(new Error('App version not detected yet'), [], null); return; }
    var body = { app_version_id: vid, component_name: componentName, config: config };
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
      .then(function (result) { callback(null, result.data || [], result.total, result.grand_totals); })
      .catch(function (err) { callback(err, [], null, null); });
  }

  function defaultConfig() {
    return {
      enabled: false, rowFields: [], colFields: [], valueField: '', aggregator: 'count',
      showTitle: true, titleAlias: '',
      showRowTotal: true, rowTotalLabel: 'Total',
      showGrandTotal: true, grandTotalLabel: 'Grand Total',
      showSubtotal: false, subtotalLabel: 'Subtotal',
      backendPivot: true,
      alignRowFields: 'left', alignColValues: 'right', alignRowTotal: 'right',
      alignGrandTotal: 'right', alignSubtotal: 'right',
      styleRowFields: 'bold', styleColValues: '', styleRowTotal: '',
      styleGrandTotal: 'bold', styleSubtotal: 'bold italic',
      emptyValue: '-',
      pageSize: 0, // 0 = all
    };
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
  const AGG = {
    count: { label: 'Count', fn: (v) => v.length },
    sum:   { label: 'Sum',   fn: (v) => v.reduce((a, b) => a + (parseFloat(b) || 0), 0) },
    avg:   { label: 'Avg',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? (n.reduce((a, b) => a + b, 0) / n.length).toFixed(2) : 0; } },
    min:   { label: 'Min',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? Math.min(...n) : ''; } },
    max:   { label: 'Max',   fn: (v) => { const n = v.map(Number).filter((x) => !isNaN(x)); return n.length ? Math.max(...n) : ''; } },
  };

  // ===================== DATA EXTRACTION + CACHE =====================
  // Cache per component name — survives display:none (virtualized table renders 0 rows when hidden)
  var CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  var dataCache = {}; // componentName -> { columns: [], data: [], _ts: timestamp }

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
          result._ts = Date.now(); dataCache[name] = result;
        }
        // Re-hide
        if (wasHidden && dataArea) dataArea.style.display = 'none';
        callback(result.data.length > 0 ? result : (name && dataCache[name]) ? dataCache[name] : result);
      }, 150);
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
        tableEl.style.minHeight = (pivotH + headerH + 4) + 'px';
        tableEl.style.height = 'auto';
      }
    });
  }

  function buildTitleHTML(config) {
    var title = (config.showTitle !== false && config.titleAlias) ? config.titleAlias : '';
    return '<div class="pivot-title-bar">' +
      (title ? '<span class="pivot-title-text">' + esc(title) + '</span>' : '<span></span>') +
      '<div class="pivot-toolbar">' +
      '<button class="pivot-download-btn" data-format="excel" title="Download Excel">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
      ' Excel</button>' +
      '</div></div>';
  }

  // ===================== DOWNLOAD =====================
  function downloadPivotExcel(overlayEl, config, filename) {
    var table = overlayEl.querySelector('.pivot-table');
    if (!table) return;
    var title = (config && config.titleAlias) ? config.titleAlias : '';
    var X = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

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

        var cell = cells[ci], text = cell.textContent.trim();
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
          overlayEl.innerHTML = buildTitleHTML(config) + '<div class="pivot-empty"><span class="pivot-spinner"></span> Loading page ' + (page + 1) + '...</div>';
          executePivotAsync(componentName, config, function (err, rows, total, grandTotals) {
            if (err) {
              overlayEl.innerHTML = buildTitleHTML(config) + '<div class="pivot-empty" style="color:#e5484d">' + esc(err.message) + '</div>';
              return;
            }
            var pData = rows.map(function (row) {
              var r = {};
              for (var k in row) {
                if (k === '_pivot_value' || k === '_pivot_count') continue;
                r[k] = row[k];
              }
              r[config.valueField || '_count'] = row['_pivot_value'];
              return r;
            });
            overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(pData, config, componentName, total, grandTotals);
            bindDownloadButtons(overlayEl, componentName);
            bindPaginationButtons(overlayEl, componentName, pData, config, tableEl, total);
            if (tableEl) adjustPivotHeight(tableEl, overlayEl);
            var scroll = overlayEl.querySelector('.pivot-result-scroll');
            if (scroll) scroll.scrollTop = 0;
          }, page, pageSize);
        } else {
          // Frontend paging: re-render from local data
          overlayEl.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, componentName);
          bindDownloadButtons(overlayEl, componentName);
          bindPaginationButtons(overlayEl, componentName, data, config, tableEl);
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
  function renderPivotHTML(data, config, componentName, serverTotal, serverGrandTotals) {
    var result = computePivot(data, config);
    var tree = result.tree;
    var colValues = result.colValues;
    var rowKeys = result.rowKeys;
    var rowFieldValues = result.rowFieldValues;
    var aggFn = AGG[config.aggregator]?.fn || AGG.count.fn;
    // Store component name for pagination state lookup
    config._componentName = componentName || config._componentName || '';
    var _serverTotal = serverTotal; // null = frontend paging, number = backend paging

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

    // ---- PAGINATION ----
    var pageSize = config.pageSize || 0; // 0 = all
    var isBackendPaged = _serverTotal !== null && _serverTotal !== undefined;
    var totalDataRows = isBackendPaged ? _serverTotal : rowKeys.length;
    var totalPages = pageSize > 0 ? Math.ceil(totalDataRows / pageSize) : 1;
    var currentPage = getPivotPage(config._componentName || '') || 0;
    if (currentPage >= totalPages) currentPage = Math.max(0, totalPages - 1);

    // Determine which row keys to show on this page
    var pageRowKeys, pageRowGroups;
    if (isBackendPaged) {
      // Backend already returned only the current page's data — no slicing needed
      pageRowKeys = rowKeys;
      pageRowGroups = rowGroups;
    } else if (pageSize > 0) {
      var startIdx = currentPage * pageSize;
      var endIdx = Math.min(startIdx + pageSize, totalDataRows);
      pageRowKeys = rowKeys.slice(startIdx, endIdx);

      // Rebuild row groups for paginated keys (for subtotals)
      if (showSubtotal) {
        pageRowGroups = {};
        for (var pri = 0; pri < pageRowKeys.length; pri++) {
          var pFirstField = (rowFieldValues[pageRowKeys[pri]] || [''])[0];
          if (!pageRowGroups[pFirstField]) pageRowGroups[pFirstField] = [];
          pageRowGroups[pFirstField].push(pageRowKeys[pri]);
        }
      }
    } else {
      pageRowKeys = rowKeys;
      pageRowGroups = rowGroups;
    }

    // Data rows (with optional subtotals)
    if (showSubtotal) {
      var groupOrder = Object.keys(pageRowGroups).sort();
      for (var gIdx = 0; gIdx < groupOrder.length; gIdx++) {
        var gKey = groupOrder[gIdx];
        var gRows = pageRowGroups[gKey];
        for (var gri = 0; gri < gRows.length; gri++) {
          h += renderRow(gRows[gri]);
        }
        if (gRows.length > 1 || groupOrder.length > 1) {
          h += renderSubtotalRow(gRows, gKey);
        }
      }
    } else {
      for (var ri = 0; ri < pageRowKeys.length; ri++) {
        h += renderRow(pageRowKeys[ri]);
      }
    }

    // Grand total row
    if (showGrandTotal) {
      h += '<tr class="pivot-grand-total">';
      h += '<td class="pivot-row-label" colspan="' + numRowCols + '"' + sf(aGT, sGT) + '>' + esc(grandTotalLabel) + '</td>';

      if (isBackendPaged && serverGrandTotals && serverGrandTotals.length > 0) {
        // Use server-computed grand totals (accurate across ALL data, not just current page)
        if (showCols) {
          // Build lookup: colKey -> _pivot_value from server grand totals
          var gtMap = {};
          var gtOverall = 0;
          for (var gti = 0; gti < serverGrandTotals.length; gti++) {
            var gtRow = serverGrandTotals[gti];
            var gtColParts = colFields.length ? colFields.map(function (f) { return gtRow[f] ?? '(empty)'; }) : [];
            var gtKey = gtColParts.join('\x00');
            gtMap[gtKey] = gtRow._pivot_value;
            gtOverall += parseFloat(gtRow._pivot_value) || 0;
          }
          for (var ck = 0; ck < colValues.length; ck++) {
            var gtVal = gtMap[colValues[ck]];
            h += '<td class="pivot-cell"' + sf(aGT, sGT) + '>' + (gtVal !== undefined ? gtVal : esc(emptyVal)) + '</td>';
          }
        } else {
          // No column fields: server returns single overall total
          // (handled by showRowTotal below)
        }
        if (showRowTotal) {
          // Overall total: sum all grand total values
          var gtSum = 0;
          for (var gts = 0; gts < serverGrandTotals.length; gts++) {
            gtSum += parseFloat(serverGrandTotals[gts]._pivot_value) || 0;
          }
          h += '<td class="pivot-cell pivot-total-cell"' + sf(aGT, sGT) + '>' + gtSum + '</td>';
        }
      } else {
        // Frontend computation (non-paginated or no server grand totals)
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

        updatePreview(widgetName, config);
      }

      // Enable toggle + value field + aggregation
      var simpleInputs = section.querySelectorAll('.pivot-cfg-enable, .pivot-cfg-showTitle, .pivot-cfg-valueField, .pivot-cfg-aggregator, .pivot-cfg-showRowTotal, .pivot-cfg-showGrandTotal, .pivot-cfg-showSubtotal, .pivot-cfg-emptyValue, .pivot-cfg-pageSize');
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
              // Supported: force on, disable toggle (always use backend for SQL)
              if (backendCb) {
                backendCb.checked = true;
                backendCb.disabled = true;
              }
              if (backendInfo) backendInfo.textContent = 'Query: ' + (result.query_name || '?') + ' (' + result.kind + ')';
              // Ensure config has backendPivot=true and save to DB (fix old bad configs)
              var cfgOn = getConfig(widgetName);
              if (!cfgOn.backendPivot) {
                cfgOn.backendPivot = true;
                setConfig(widgetName, cfgOn); // save to memory + localStorage + API
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
        var renderIntoOverlay = function (data, serverTotal, serverGrandTotals) {
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
          ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, widgetName, serverTotal, serverGrandTotals);
          bindDownloadButtons(ov, widgetName);
          bindPaginationButtons(ov, widgetName, data, config, tableEl, serverTotal);
          adjustPivotHeight(tableEl, ov);
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
          showOverlayMsg('<span class="pivot-spinner"></span> <span class="pivot-spinner"></span> Loading...');
          var bpPageSize = config.pageSize || 0;
          var bpPage = bpPageSize > 0 ? getPivotPage(widgetName) : 0;
          executePivotAsync(widgetName, config, function (err, rows, total, grandTotals) {
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
            var data = rows.map(function (row) {
              var r = {};
              for (var k in row) {
                if (k === '_pivot_value' || k === '_pivot_count') continue;
                r[k] = row[k];
              }
              r[config.valueField || '_count'] = row['_pivot_value'];
              return r;
            });
            renderIntoOverlay(data, total, grandTotals);
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

      // Case 2: Different widget selected (or renamed)
      if (widgetName !== activeWidget) {

        // Carry config from old name to new name if new name has no config
        // Handles both rename and intermediate typing states
        var isRename = false;
        if (activeWidget && configCache[activeWidget] && !configCache[widgetName]) {
          isRename = true;
          configCache[widgetName] = configCache[activeWidget];
          saveConfigLocal(widgetName, configCache[widgetName]);
          // Save to API (creates row with new name in DB)
          saveConfig(widgetName, configCache[widgetName]);
          // Retry after 2s + 5s (ToolJet DB name commit may lag)
          var _carryName = widgetName;
          setTimeout(function () { if (configCache[_carryName]) saveConfig(_carryName, configCache[_carryName]); }, 2000);
          setTimeout(function () { if (configCache[_carryName]) saveConfig(_carryName, configCache[_carryName]); }, 5000);
          console.log(LOG_PREFIX, 'Config carried:', activeWidget, '→', widgetName);
        }

        _previousWidget = activeWidget;
        if (section) section.remove();
        activeWidget = widgetName;
        section = null;
        _configRetryCount = 0;
        refreshColumns(widgetName);
        console.log(LOG_PREFIX, 'Table selected:', widgetName, 'columns:', cachedColumns);

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
            var kPageSize = config.pageSize || 0;
            var kPage = kPageSize > 0 ? getPivotPage(name) : 0;
            // Use cache if available (avoid repeated API calls / retry loops)
            if (_backendPivotCache[name]) {
              if (_backendPivotCache[name].failed) return; // failed before, don't retry (use frontend fallback)
              if (_backendPivotCache[name].data && !kPageSize) {
                var ov = ensureOverlay();
                ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(_backendPivotCache[name].data, config, name);
                bindDownloadButtons(ov, name);
                bindPaginationButtons(ov, name, _backendPivotCache[name].data, config, tableEl);
                return;
              }
            }
            // Fetch from backend (once, then cache)
            if (_backendPivotPending[name]) return; // already in-flight
            _backendPivotPending[name] = true;
            executePivotAsync(name, config, function (err, rows, total, grandTotals) {
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
              if (!kPageSize) _backendPivotCache[name] = { data: data, timestamp: Date.now() };
              var ov = ensureOverlay();
              ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, name, total, grandTotals);
              bindDownloadButtons(ov, name);
              bindPaginationButtons(ov, name, data, config, tableEl, total);
            }, kPage, kPageSize);
          } else {
            // Frontend pivot: extract from DOM
            extractDataAsync(tableEl, function (extracted) {
              if (extracted.data.length === 0) return;
              var ov = ensureOverlay();
              ov.innerHTML = buildTitleHTML(config) + renderPivotHTML(extracted.data, config, name);
              bindDownloadButtons(ov, name);
              bindPaginationButtons(ov, name, extracted.data, config, tableEl);
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

      function renderPivot(data, serverTotal, serverGrandTotals) {
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

        overlay.innerHTML = buildTitleHTML(config) + renderPivotHTML(data, config, name, serverTotal, serverGrandTotals);
        overlay.style.display = 'flex';
        bindDownloadButtons(overlay, name);
        bindPaginationButtons(overlay, name, data, config, tableEl, serverTotal);
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
        overlay.innerHTML = '<div class="pivot-empty"><span class="pivot-spinner"></span> Loading...</div>';
      }

      function showError(msg) {
        var overlay = tableEl.querySelector('.pivot-overlay');
        if (overlay) overlay.innerHTML = '<div class="pivot-empty" style="color:#e5484d">' + esc(msg) + '</div>';
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
          executePivotAsync(name, config, function (err, rows, total, grandTotals) {
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
          console.log(LOG_PREFIX, 'Backend pivot rendered:', name, data.length, 'rows', 'total:', total);
          renderPivot(data, total, grandTotals);
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
