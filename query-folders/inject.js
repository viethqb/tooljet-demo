/**
 * Query Folders - Frontend Injection Script
 * Adds folder management to ToolJet's Query Panel via DOM manipulation.
 */
(function () {
  'use strict';

  // ===================== STATE =====================
  const state = {
    folders: [],
    queryFolderMap: {}, // queryId -> folderId
    activeFolderId: null, // null = show all
    collapsedFolders: new Set(),
    appVersionId: null,
    initialized: false,
    loading: false, // prevent concurrent loads
    dragQueryId: null,
  };

  // ===================== SVG ICONS =====================
  const ICONS = {
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    folderOpen: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v1"/><path d="M2 10h20l-2 9H4l-2-9z"/></svg>',
    chevron: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>',
    plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    move: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
    subfolder: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
  };

  // ===================== API HELPERS =====================
  // Intercept fetch to capture tj-workspace-id AND app version ID from ToolJet API calls
  let _workspaceId = null;
  let _detectedVersionId = null;
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    const [url, opts] = args;
    const urlStr = typeof url === 'string' ? url : (url instanceof Request ? url.url : '');

    // Capture workspace ID from headers
    if (opts && opts.headers) {
      const wid =
        (opts.headers instanceof Headers ? opts.headers.get('tj-workspace-id') : opts.headers['tj-workspace-id']);
      if (wid) _workspaceId = wid;
    }

    // Capture version ID from data-queries API calls: GET /api/data-queries/:versionId
    const versionMatch = urlStr.match(/\/api\/data-queries\/([a-f0-9-]{36})(?:\?|$)/);
    if (versionMatch) {
      const newVersionId = versionMatch[1];
      if (newVersionId !== _detectedVersionId) {
        _detectedVersionId = newVersionId;
        if (state.appVersionId && state.appVersionId !== newVersionId) {
          state.appVersionId = newVersionId;
          state.initialized = false;
          setTimeout(() => tryInit(), 500);
        }
      }
    }

    // Intercept new query creation (POST /api/data-queries/data-sources/...)
    // After a new query is created, reload folders to auto-assign it to "Ungrouped"
    const isCreateQuery = opts && opts.method === 'POST' && urlStr.match(/\/api\/data-queries\/data-sources\//);

    const result = _origFetch.apply(this, args);

    if (isCreateQuery) {
      result.then((res) => {
        if (res.ok) {
          // Reload folders after short delay to let the query be committed
          setTimeout(() => {
            if (state.appVersionId) loadFolders();
          }, 1500);
        }
      }).catch(() => {});
    }

    return result;
  };

  function getWorkspaceId() {
    if (_workspaceId) return _workspaceId;
    const match = window.location.pathname.match(/^\/([a-f0-9-]{36})\//);
    if (match) return match[1];
    return null;
  }

  async function apiFetch(path, options = {}) {
    const wid = getWorkspaceId();
    const headers = { 'Content-Type': 'application/json' };
    if (wid) headers['tj-workspace-id'] = wid;

    const res = await fetch(`/api/query-folders${path}`, {
      ...options,
      headers,
      credentials: 'include', // sends httpOnly tj_auth_token cookie
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    return data;
  }

  // ===================== DATA FUNCTIONS =====================
  async function loadFolders() {
    if (!state.appVersionId || state.loading) return;
    state.loading = true;
    try {
      // Ensure "Ungrouped" default folder exists and assign unassigned queries
      await apiFetch(`/ensure-default/${state.appVersionId}`, { method: 'POST' });

      const [foldersData, queriesData] = await Promise.all([
        apiFetch(`/${state.appVersionId}`),
        apiFetch(`/queries/${state.appVersionId}`),
      ]);
      state.folders = foldersData.folders || [];
      state.queryFolderMap = {};
      (queriesData.queries || []).forEach((q) => {
        if (q.folder_id) {
          state.queryFolderMap[q.id] = q.folder_id;
        }
      });
      renderFolderTree();
      applyFolderFilter();
      setupDragAndDrop();
    } catch (err) {
      console.error('[QueryFolders] Error loading folders:', err);
    } finally {
      state.loading = false;
    }
  }

  async function createFolder(name, parentId = null) {
    try {
      await apiFetch('', {
        method: 'POST',
        body: JSON.stringify({
          name,
          parent_id: parentId,
          app_version_id: state.appVersionId,
        }),
      });
      showToast('Folder created', 'success');
      // Keep showing all queries after folder creation
      state.activeFolderId = null;
      await loadFolders();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function renameFolder(id, name) {
    try {
      const folder = state.folders.find((f) => f.id === id);
      await apiFetch(`/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, parent_id: folder?.parent_id }),
      });
      showToast('Folder renamed', 'success');
      await loadFolders();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function deleteFolder(id) {
    try {
      await apiFetch(`/${id}`, { method: 'DELETE' });
      if (state.activeFolderId === id) state.activeFolderId = null;
      showToast('Folder deleted', 'success');
      await loadFolders();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function moveQueryToFolder(queryId, folderId) {
    try {
      await apiFetch('/move-query', {
        method: 'PUT',
        body: JSON.stringify({ query_id: queryId, folder_id: folderId }),
      });
      if (folderId) {
        state.queryFolderMap[queryId] = folderId;
      } else {
        delete state.queryFolderMap[queryId];
      }
      renderFolderTree();
      applyFolderFilter();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ===================== DETECT APP VERSION =====================
  function detectAppVersionId() {
    // 1. Best source: captured from intercepted data-queries API calls
    if (_detectedVersionId) {
      return _detectedVersionId;
    }

    // 2. Try from performance entries (data-queries calls that happened before our script)
    try {
      const perfEntries = performance.getEntriesByType('resource');
      for (let i = perfEntries.length - 1; i >= 0; i--) {
        const entry = perfEntries[i];
        const match = entry.name.match(/\/api\/data-queries\/([a-f0-9-]{36})(?:\?|$)/);
        if (match) {
          _detectedVersionId = match[1];
          return _detectedVersionId;
        }
      }
    } catch (e) {
      // Ignore
    }

    // 3. Try from Zustand store via React fiber
    try {
      const queryManagerEl = document.getElementById('query-manager');
      if (queryManagerEl) {
        const fiberKey = Object.keys(queryManagerEl).find((k) => k.startsWith('__reactFiber'));
        if (fiberKey) {
          let fiber = queryManagerEl[fiberKey];
          for (let i = 0; i < 50 && fiber; i++) {
            if (fiber.memoizedProps?.store || fiber.pendingProps?.store) {
              const store = fiber.memoizedProps?.store || fiber.pendingProps?.store;
              const storeState = store.getState?.();
              if (storeState?.currentVersionId) {
                return storeState.currentVersionId;
              }
            }
            fiber = fiber.return;
          }
        }
      }
    } catch (e) {
      // Ignore fiber traversal errors
    }

    return null;
  }

  // ===================== FOLDER TREE RENDERING =====================
  function buildFolderHierarchy() {
    const rootFolders = [];
    const childMap = {};

    state.folders.forEach((f) => {
      if (!childMap[f.parent_id || 'root']) childMap[f.parent_id || 'root'] = [];
      childMap[f.parent_id || 'root'].push(f);
    });

    function buildTree(parentId = 'root', depth = 0) {
      const children = childMap[parentId] || [];
      return children
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((folder) => ({
          ...folder,
          depth,
          children: buildTree(folder.id, depth + 1),
        }));
    }

    return buildTree();
  }

  function countQueriesInFolder(folderId) {
    let count = 0;
    // Direct queries
    Object.values(state.queryFolderMap).forEach((fId) => {
      if (fId === folderId) count++;
    });
    // Sub-folder queries
    state.folders
      .filter((f) => f.parent_id === folderId)
      .forEach((child) => {
        count += countQueriesInFolder(child.id);
      });
    return count;
  }

  function renderFolderTree() {
    const container = document.querySelector('.qf-folder-tree');
    if (!container) return;

    const tree = buildFolderHierarchy();
    const totalQueries = document.querySelectorAll('.query-list .query-row').length;

    // Build HTML without inline handlers
    let html = '';

    html += `
      <div class="qf-folder-item qf-all-queries ${state.activeFolderId === null ? 'active' : ''}" data-folder-id="" data-action="select">
        <span class="qf-folder-icon">${ICONS.list}</span>
        <span class="qf-folder-name">All Queries</span>
        <span class="qf-folder-count">${totalQueries}</span>
      </div>`;

    function renderFolder(folder) {
      const isCollapsed = state.collapsedFolders.has(folder.id);
      const isActive = state.activeFolderId === folder.id;
      const hasChildren = folder.children && folder.children.length > 0;
      const queryCount = countQueriesInFolder(folder.id);
      const indent = folder.depth * 16;

      html += `
        <div class="qf-folder-item ${isActive ? 'active' : ''}" data-folder-id="${folder.id}" data-action="select" data-drop-target="true">
          <span class="qf-folder-item-indent" style="width:${indent}px"></span>
          ${hasChildren
            ? `<span class="qf-folder-toggle ${isCollapsed ? 'collapsed' : ''}" data-action="toggle" data-folder-id="${folder.id}">${ICONS.chevron}</span>`
            : '<span style="width:16px;display:inline-block;flex-shrink:0"></span>'
          }
          <span class="qf-folder-icon">${isActive || !isCollapsed ? ICONS.folderOpen : ICONS.folder}</span>
          <span class="qf-folder-name">${escapeHtml(folder.name)}</span>
          <span class="qf-folder-count">${queryCount}</span>
          <span class="qf-folder-actions">
            <button class="qf-btn-icon" data-action="rename" data-folder-id="${folder.id}" title="Rename">${ICONS.edit}</button>
            <button class="qf-btn-icon" data-action="delete" data-folder-id="${folder.id}" title="Delete">${ICONS.trash}</button>
          </span>
        </div>`;

      if (!isCollapsed && folder.children) {
        folder.children.forEach(renderFolder);
      }
    }

    tree.forEach(renderFolder);
    container.innerHTML = html;
    // Event listeners are handled by persistent delegation set up in bindFolderTreeEvents()
  }

  // One-time delegation setup on the folder tree container (called once, never re-added)
  let _folderTreeBound = false;
  function bindFolderTreeEvents() {
    if (_folderTreeBound) return;
    const container = document.querySelector('.qf-folder-tree');
    if (!container) return;
    _folderTreeBound = true;

    container.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const folderId = actionEl.dataset.folderId;
      if (action === 'toggle') { e.stopPropagation(); window.__qf.toggleFolder(folderId); }
      else if (action === 'rename') { e.stopPropagation(); window.__qf.showRenameModal(folderId); }
      else if (action === 'delete') { e.stopPropagation(); window.__qf.showDeleteConfirm(folderId); }
      else if (action === 'select') { window.__qf.setActiveFolder(folderId || null); }
    });

    container.addEventListener('contextmenu', (e) => {
      const folderItem = e.target.closest('.qf-folder-item[data-folder-id]');
      if (folderItem && folderItem.dataset.folderId) {
        window.__qf.showContextMenu(e, folderItem.dataset.folderId);
      }
    });

    container.addEventListener('dragover', (e) => {
      const target = e.target.closest('[data-drop-target]');
      if (!target) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-target');
    });

    container.addEventListener('dragleave', (e) => {
      const target = e.target.closest('[data-drop-target]');
      if (target) target.classList.remove('drop-target');
    });

    container.addEventListener('drop', (e) => {
      const target = e.target.closest('[data-drop-target]');
      if (!target) return;
      e.preventDefault();
      target.classList.remove('drop-target');
      const queryId = e.dataTransfer.getData('text/plain') || state.dragQueryId;
      if (queryId) moveQueryToFolder(queryId, target.dataset.folderId);
    });
  }

  // ===================== FOLDER FILTERING =====================
  function applyFolderFilter() {
    const queryRows = document.querySelectorAll('.query-list .query-row');
    if (!queryRows.length) return;

    queryRows.forEach((row) => {
      if (state.activeFolderId === null) {
        // "All Queries" - show everything
        row.style.display = '';
        return;
      }

      const queryId = getQueryIdFromRow(row);
      if (!queryId) {
        row.style.display = '';
        return;
      }

      const queryFolderId = state.queryFolderMap[queryId] || null;
      const visibleFolderIds = [state.activeFolderId, ...getDescendantFolderIds(state.activeFolderId)];
      row.style.display = visibleFolderIds.includes(queryFolderId) ? '' : 'none';
    });
  }

  function getDescendantFolderIds(folderId) {
    const descendants = [];
    state.folders.forEach((f) => {
      if (f.parent_id === folderId) {
        descendants.push(f.id);
        descendants.push(...getDescendantFolderIds(f.id));
      }
    });
    return descendants;
  }

  function getQueryIdFromRow(row) {
    // Try to get query ID from the React component's props
    const fiberKey = Object.keys(row).find((k) => k.startsWith('__reactFiber'));
    if (fiberKey) {
      let fiber = row[fiberKey];
      for (let i = 0; i < 10 && fiber; i++) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props?.dataQuery?.id) return props.dataQuery.id;
        fiber = fiber.return;
      }
    }

    // Fallback: use data attribute or button ID
    const menuBtn = row.querySelector('[id^="query-handler-menu-"]');
    if (menuBtn) {
      return menuBtn.id.replace('query-handler-menu-', '');
    }

    return null;
  }

  // ===================== DRAG AND DROP =====================
  const _boundDragRows = new WeakSet();
  function setupDragAndDrop() {
    const queryRows = document.querySelectorAll('.query-list .query-row');
    queryRows.forEach((row) => {
      if (_boundDragRows.has(row)) return;

      const queryId = getQueryIdFromRow(row);
      if (!queryId) return;

      _boundDragRows.add(row);
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (e) => {
        state.dragQueryId = queryId;
        row.classList.add('qf-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', queryId);
      });
      row.addEventListener('dragend', () => {
        state.dragQueryId = null;
        row.classList.remove('qf-dragging');
        document.querySelectorAll('.qf-folder-item.drop-target').forEach((el) => {
          el.classList.remove('drop-target');
        });
      });
    });
  }

  // ===================== MODALS =====================
  function showCreateFolderModal(parentId = null) {
    const parentFolder = parentId ? state.folders.find((f) => f.id === parentId) : null;
    const title = parentId ? `Create Subfolder in "${escapeHtml(parentFolder?.name || '')}"` : 'Create Folder';

    showModal(title, `
      <div class="qf-form-group">
        <label class="qf-label">Folder Name</label>
        <input type="text" class="qf-input" id="qf-folder-name" placeholder="Enter folder name" maxlength="50" autofocus>
      </div>
    `, [
      { text: 'Cancel', class: 'qf-btn qf-btn-secondary', action: 'close' },
      {
        text: 'Create',
        class: 'qf-btn qf-btn-primary',
        action: async () => {
          const name = document.getElementById('qf-folder-name').value.trim();
          if (!name) return showToast('Please enter a folder name', 'error');
          await createFolder(name, parentId);
          closeModal();
        },
      },
    ]);

    // Focus and enter key
    setTimeout(() => {
      const input = document.getElementById('qf-folder-name');
      if (input) {
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const btn = document.querySelector('.qf-modal-footer .qf-btn-primary');
            if (btn) btn.click();
          }
        });
      }
    }, 100);
  }

  function showRenameModal(folderId) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return;

    showModal('Rename Folder', `
      <div class="qf-form-group">
        <label class="qf-label">Folder Name</label>
        <input type="text" class="qf-input" id="qf-folder-name" value="${escapeHtml(folder.name)}" maxlength="50" autofocus>
      </div>
    `, [
      { text: 'Cancel', class: 'qf-btn qf-btn-secondary', action: 'close' },
      {
        text: 'Rename',
        class: 'qf-btn qf-btn-primary',
        action: async () => {
          const name = document.getElementById('qf-folder-name').value.trim();
          if (!name) return showToast('Please enter a folder name', 'error');
          await renameFolder(folderId, name);
          closeModal();
        },
      },
    ]);

    setTimeout(() => {
      const input = document.getElementById('qf-folder-name');
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const btn = document.querySelector('.qf-modal-footer .qf-btn-primary');
            if (btn) btn.click();
          }
        });
      }
    }, 100);
  }

  function showDeleteConfirm(folderId) {
    const folder = state.folders.find((f) => f.id === folderId);
    if (!folder) return;

    const queryCount = countQueriesInFolder(folderId);
    const message = queryCount > 0
      ? `This folder contains ${queryCount} query(ies). They will be moved to ungrouped.`
      : 'This folder is empty.';

    showModal('Delete Folder', `
      <p style="margin:0;font-size:14px;color:var(--slate11,#475569)">
        Are you sure you want to delete "<strong>${escapeHtml(folder.name)}</strong>"?
      </p>
      <p style="margin:8px 0 0;font-size:13px;color:var(--slate9,#64748b)">
        ${message}
      </p>
    `, [
      { text: 'Cancel', class: 'qf-btn qf-btn-secondary', action: 'close' },
      {
        text: 'Delete',
        class: 'qf-btn qf-btn-danger',
        action: async () => {
          await deleteFolder(folderId);
          closeModal();
        },
      },
    ]);
  }

  function showMoveQueryModal(queryId) {
    const currentFolderId = state.queryFolderMap[queryId] || null;

    let optionsHtml = `<option value="" ${!currentFolderId ? 'selected' : ''}>-- No Folder (Root) --</option>`;

    function addFolderOptions(folders, depth = 0) {
      folders.forEach((f) => {
        const indent = '&nbsp;&nbsp;'.repeat(depth);
        const selected = currentFolderId === f.id ? 'selected' : '';
        optionsHtml += `<option value="${f.id}" ${selected}>${indent}${escapeHtml(f.name)}</option>`;
        const children = state.folders.filter((c) => c.parent_id === f.id);
        addFolderOptions(children, depth + 1);
      });
    }

    const rootFolders = state.folders.filter((f) => !f.parent_id);
    addFolderOptions(rootFolders);

    showModal('Move Query to Folder', `
      <div class="qf-form-group">
        <label class="qf-label">Select Folder</label>
        <select class="qf-select" id="qf-target-folder">
          ${optionsHtml}
        </select>
      </div>
    `, [
      { text: 'Cancel', class: 'qf-btn qf-btn-secondary', action: 'close' },
      {
        text: 'Move',
        class: 'qf-btn qf-btn-primary',
        action: async () => {
          const targetFolderId = document.getElementById('qf-target-folder').value || null;
          await moveQueryToFolder(queryId, targetFolderId);
          closeModal();
        },
      },
    ]);
  }

  function showModal(title, bodyHtml, buttons) {
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'qf-modal-overlay';
    overlay.id = 'qf-modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    const buttonsHtml = buttons
      .map((btn, i) => `<button class="${escapeHtml(btn.class)}" data-btn-idx="${i}">${escapeHtml(btn.text)}</button>`)
      .join('');

    overlay.innerHTML = `
      <div class="qf-modal">
        <div class="qf-modal-header">
          <h3 class="qf-modal-title">${escapeHtml(title)}</h3>
          <button class="qf-modal-close" data-btn-close="true">${ICONS.close}</button>
        </div>
        <div class="qf-modal-body">${bodyHtml}</div>
        <div class="qf-modal-footer">${buttonsHtml}</div>
      </div>`;

    // Stop propagation on modal itself
    overlay.querySelector('.qf-modal').addEventListener('click', (e) => e.stopPropagation());

    // Close button
    overlay.querySelector('[data-btn-close]').addEventListener('click', closeModal);

    // Footer buttons
    overlay.querySelectorAll('[data-btn-idx]').forEach((el) => {
      const idx = parseInt(el.dataset.btnIdx);
      const btn = buttons[idx];
      el.addEventListener('click', () => {
        if (btn.action === 'close') closeModal();
        else if (typeof btn.action === 'function') btn.action();
      });
    });

    document.body.appendChild(overlay);
  }

  function closeModal() {
    const overlay = document.getElementById('qf-modal-overlay');
    if (overlay) overlay.remove();
  }

  // ===================== CONTEXT MENU =====================
  function showContextMenu(e, folderId) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'qf-context-menu';
    menu.id = 'qf-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    menu.innerHTML = `
      <button class="qf-context-menu-item" data-ctx="rename">${ICONS.edit} Rename</button>
      <button class="qf-context-menu-item" data-ctx="subfolder">${ICONS.subfolder} Create Subfolder</button>
      <div class="qf-context-menu-divider"></div>
      <button class="qf-context-menu-item danger" data-ctx="delete">${ICONS.trash} Delete</button>`;

    menu.querySelector('[data-ctx="rename"]').addEventListener('click', () => { showRenameModal(folderId); closeContextMenu(); });
    menu.querySelector('[data-ctx="subfolder"]').addEventListener('click', () => { showCreateFolderModal(folderId); closeContextMenu(); });
    menu.querySelector('[data-ctx="delete"]').addEventListener('click', () => { showDeleteConfirm(folderId); closeContextMenu(); });

    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

    setTimeout(() => {
      document.addEventListener('click', closeContextMenu, { once: true });
    }, 0);
  }

  function closeContextMenu() {
    const menu = document.getElementById('qf-context-menu');
    if (menu) menu.remove();
  }

  // ===================== QUERY CARD CONTEXT MENU INJECTION =====================
  // Uses the same main MutationObserver (no extra observer).
  // Called from debouncedTryInit cycle.
  function injectMoveToFolderOption() {
    const menus = document.querySelectorAll('[class*="query-handler-menu"]');
    menus.forEach((menu) => {
      if (menu.querySelector('.qf-move-to-folder-btn')) return;

      const menuId = menu.id || '';
      const queryId = menuId.replace('query-handler-menu-', '');
      if (!queryId) return;

      const menuItems = menu.querySelectorAll('[role="menuitem"], button, .dropdown-item');
      if (menuItems.length > 0) {
        const moveBtn = document.createElement('button');
        moveBtn.className = (menuItems[0].className || '') + ' qf-move-to-folder-btn';
        moveBtn.innerHTML = `${ICONS.move} Move to Folder`;
        moveBtn.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;';
        moveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.style.display = 'none';
          showMoveQueryModal(queryId);
        });
        const lastItem = menuItems[menuItems.length - 1];
        lastItem.parentNode.insertBefore(moveBtn, lastItem);
      }
    });
  }

  // ===================== TOAST =====================
  function showToast(message, type = 'success') {
    const existing = document.querySelector('.qf-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `qf-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  }

  // ===================== UTILITIES =====================
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ===================== DOM INJECTION =====================
  // Returns: 'exists' if already in DOM, 'injected' if freshly added, false if can't inject
  function injectFolderUI() {
    const dataPane = document.querySelector('.data-pane .queries-container');
    if (!dataPane) return false;
    if (dataPane.querySelector('.qf-folder-header')) return 'exists';

    const queryList = dataPane.querySelector('.query-list');
    if (!queryList) return false;

    const folderHeader = document.createElement('div');
    folderHeader.className = 'qf-folder-header';
    folderHeader.innerHTML = `
      <span class="qf-folder-header-title">Folders</span>
      <span class="qf-folder-header-actions">
        <button class="qf-btn-icon" id="qf-create-folder-btn" title="Create folder">
          ${ICONS.plus}
        </button>
      </span>`;
    folderHeader.querySelector('#qf-create-folder-btn').addEventListener('click', () => showCreateFolderModal());

    const folderTree = document.createElement('div');
    folderTree.className = 'qf-folder-tree';

    queryList.parentNode.insertBefore(folderHeader, queryList);
    queryList.parentNode.insertBefore(folderTree, queryList);

    return 'injected';
  }

  // ===================== INITIALIZATION =====================
  function tryInit() {
    const queryManager = document.getElementById('query-manager');
    if (!queryManager) return;

    const dataPane = document.querySelector('.data-pane .queries-container');
    if (!dataPane) return;

    const versionId = detectAppVersionId();
    if (!versionId) return;

    if (state.appVersionId !== versionId) {
      state.appVersionId = versionId;
      state.folders = [];
      state.queryFolderMap = {};
      state.activeFolderId = null;
      state.initialized = false;
    }

    const injectResult = injectFolderUI();
    if (!injectResult) return;

    if (injectResult === 'injected') {
      // DOM was (re)created — need to rebind delegation listeners
      _folderTreeBound = false;
    }

    bindFolderTreeEvents();

    if (!state.initialized) {
      state.initialized = true;
      loadFolders();
    } else if (injectResult === 'injected') {
      // Panel reopened: re-render from cached state (no API call)
      renderFolderTree();
      applyFolderFilter();
    }

    // Always check for new query rows that need drag-and-drop (React re-renders create new DOM)
    setupDragAndDrop();
    // Check for query context menus that need "Move to Folder" button
    injectMoveToFolderOption();
  }

  // ===================== GLOBAL API =====================
  window.__qf = {
    setActiveFolder(folderId) {
      state.activeFolderId = folderId;
      renderFolderTree();
      applyFolderFilter();
    },

    toggleFolder(folderId) {
      if (state.collapsedFolders.has(folderId)) {
        state.collapsedFolders.delete(folderId);
      } else {
        state.collapsedFolders.add(folderId);
      }
      renderFolderTree();
    },

    showCreateFolderModal,
    showRenameModal,
    showDeleteConfirm,
    showContextMenu,
    closeContextMenu,
    closeModal,

    onDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drop-target');
    },

    onDragLeave(e) {
      e.currentTarget.classList.remove('drop-target');
    },

    onDrop(e, folderId) {
      e.preventDefault();
      e.currentTarget.classList.remove('drop-target');
      const queryId = e.dataTransfer.getData('text/plain') || state.dragQueryId;
      if (queryId) {
        moveQueryToFolder(queryId, folderId);
      }
    },

    // Force refresh
    refresh() {
      loadFolders();
    },
  };

  // ===================== OBSERVERS =====================
  // Debounced tryInit — prevents hundreds of calls from MutationObserver
  let _tryInitTimer = null;
  function debouncedTryInit() {
    if (_tryInitTimer) return;
    _tryInitTimer = setTimeout(() => {
      _tryInitTimer = null;
      tryInit();
    }, 300);
  }

  // Observe only the query-manager area, not the entire body
  let _currentObserverTarget = null;
  function setupObserver() {
    const target = document.getElementById('query-manager') || document.body;
    if (target === _currentObserverTarget) return;

    if (_currentObserverTarget) mainObserver.disconnect();
    _currentObserverTarget = target;
    mainObserver.observe(target, { childList: true, subtree: true });
  }

  const mainObserver = new MutationObserver(debouncedTryInit);

  // URL change detection (SPA navigation)
  window.addEventListener('popstate', () => {
    state.initialized = false;
    state.appVersionId = null;
    _detectedVersionId = null;
    setTimeout(debouncedTryInit, 500);
  });

  // Initial setup
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => { setupObserver(); tryInit(); }, 2000));
  } else {
    setTimeout(() => { setupObserver(); tryInit(); }, 2000);
  }

  // Lightweight periodic check — only runs if injection is missing (panel toggle)
  setInterval(() => {
    // Narrow the observer to query-manager once it exists
    setupObserver();
    // Re-inject only if DOM was destroyed
    const dataPane = document.querySelector('.data-pane .queries-container');
    if (dataPane && !dataPane.querySelector('.qf-folder-header')) {
      tryInit();
    }
  }, 3000);

})();
