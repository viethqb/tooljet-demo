import React, { useState, useRef, useEffect } from 'react';
import cx from 'classnames';
import useStore from '@/AppBuilder/_stores/store';
import { QueryCard } from './QueryCard';
import { QueryRenameInput } from './QueryRenameInput';
import SolidIcon from '@/_ui/Icon/SolidIcons';
import { useDrop } from 'react-dnd';
import { shallow } from 'zustand/shallow';

export const QueryFolder = ({ folder, queries, darkMode }) => {
  const expandedFolderIds = useStore((state) => state.queryPanel.expandedFolderIds);
  const toggleFolderExpanded = useStore((state) => state.queryPanel.toggleFolderExpanded);
  const renamingFolderId = useStore((state) => state.queryPanel.renamingFolderId);
  const setRenamingFolder = useStore((state) => state.queryPanel.setRenamingFolder);
  const renameQueryFolder = useStore((state) => state.queryPanel.renameQueryFolder);
  const deleteQueryFolder = useStore((state) => state.queryPanel.deleteQueryFolder);
  const moveQueryToFolder = useStore((state) => state.queryPanel.moveQueryToFolder);
  const dataSources = useStore((state) => state.dataSources);
  const shouldFreeze = useStore((state) => state.getShouldFreeze());

  const isExpanded = expandedFolderIds.includes(folder.id);
  const isRenaming = renamingFolderId === folder.id;
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef(null);

  function isDataSourceLocal(dataQuery) {
    return dataSources.some((dataSource) => dataSource.id === dataQuery.data_source_id);
  }

  const [{ isOver }, drop] = useDrop({
    accept: 'QUERY_CARD',
    drop: (item) => {
      if (item.queryFolderId !== folder.id) {
        moveQueryToFolder(item.queryId, folder.id, queries.length);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  });

  const handleRename = (_, newName) => {
    if (newName && newName !== folder.name) {
      renameQueryFolder(folder.id, newName);
    } else {
      setRenamingFolder(null);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  return (
    <div ref={drop}>
      <div
        className={cx('query-folder-row', {
          expanded: isExpanded,
          'drop-target-active': isOver,
        })}
        onClick={() => toggleFolderExpanded(folder.id)}
        onContextMenu={(e) => {
          if (shouldFreeze) return;
          e.preventDefault();
          setShowMenu(true);
        }}
      >
        <div className={cx('folder-chevron', { expanded: isExpanded })}>
          <SolidIcon name="cheverondown" width="16" />
        </div>
        <div className="folder-icon">
          <SolidIcon name="folder" width="16" fill="var(--icons-default)" />
        </div>
        {isRenaming ? (
          <div className="folder-name" onClick={(e) => e.stopPropagation()}>
            <QueryRenameInput
              dataQuery={{ name: folder.name }}
              darkMode={darkMode}
              onUpdate={handleRename}
            />
          </div>
        ) : (
          <div className="folder-name">{folder.name}</div>
        )}
        <div className="folder-count">{queries.length}</div>
        {!shouldFreeze && (
          <div
            className="folder-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
          >
            <SolidIcon name="morevertical" width="14" />
          </div>
        )}
      </div>

      {showMenu && (
        <div ref={menuRef} className="query-folder-context-menu">
          <div
            className="context-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              setRenamingFolder(folder.id);
              setShowMenu(false);
            }}
          >
            Rename
          </div>
          <div
            className="context-menu-item context-menu-item-danger"
            onClick={(e) => {
              e.stopPropagation();
              deleteQueryFolder(folder.id);
              setShowMenu(false);
            }}
          >
            Delete
          </div>
        </div>
      )}

      {isExpanded && (
        <div className="query-folder-children">
          {[...queries]
            .sort((a, b) => (a.folder_position || 0) - (b.folder_position || 0))
            .map((query) => (
              <QueryCard
                key={query.id}
                dataQuery={query}
                darkMode={darkMode}
                localDs={!!isDataSourceLocal(query)}
                inFolder
              />
            ))}
          {queries.length === 0 && (
            <div className="query-folder-empty">Drop queries here</div>
          )}
        </div>
      )}
    </div>
  );
};
