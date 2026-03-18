import config from 'config';
import { authHeader, handleResponse } from '@/_helpers';

export const queryFolderService = {
  getAll,
  create,
  update,
  del,
  moveQuery,
};

function getAll(appVersionId) {
  const requestOptions = { method: 'GET', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/query-folders/${appVersionId}`, requestOptions).then(handleResponse);
}

function create(name, appVersionId, position) {
  const body = { name, app_version_id: appVersionId, position };
  const requestOptions = { method: 'POST', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/query-folders`, requestOptions).then(handleResponse);
}

function update(id, data) {
  const requestOptions = { method: 'PUT', headers: authHeader(), credentials: 'include', body: JSON.stringify(data) };
  return fetch(`${config.apiUrl}/query-folders/${id}`, requestOptions).then(handleResponse);
}

function del(id) {
  const requestOptions = { method: 'DELETE', headers: authHeader(), credentials: 'include' };
  return fetch(`${config.apiUrl}/query-folders/${id}`, requestOptions).then(handleResponse);
}

function moveQuery(folderId, queryId, position, targetFolderId) {
  const body = { query_id: queryId, folder_id: targetFolderId ?? folderId, position };
  const requestOptions = { method: 'PUT', headers: authHeader(), credentials: 'include', body: JSON.stringify(body) };
  return fetch(`${config.apiUrl}/query-folders/${folderId || 'root'}/queries`, requestOptions).then(handleResponse);
}
