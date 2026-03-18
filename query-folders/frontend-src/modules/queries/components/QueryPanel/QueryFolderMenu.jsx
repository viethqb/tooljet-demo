import React from 'react';
import useStore from '@/AppBuilder/_stores/store';

const QueryFolderMenu = ({ queryId, onClose }) => {
  const queryFolders = useStore((state) => state.queryPanel.queryFolders);
  const moveQueryToFolder = useStore((state) => state.queryPanel.moveQueryToFolder);

  const handleMove = (folderId) => {
    moveQueryToFolder(queryId, folderId);
    onClose();
  };

  return (
    <div className="query-folder-submenu">
      <div className="submenu-header">Move to folder</div>
      <div
        className="submenu-item"
        onClick={() => handleMove(null)}
      >
        No folder
      </div>
      {queryFolders.map((folder) => (
        <div
          key={folder.id}
          className="submenu-item"
          onClick={() => handleMove(folder.id)}
        >
          {folder.name}
        </div>
      ))}
    </div>
  );
};

export default QueryFolderMenu;
