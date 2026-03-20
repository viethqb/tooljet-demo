"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryFoldersService = void 0;
const common_1 = require("@nestjs/common");
const database_helper_1 = require("../../src/helpers/database.helper");

let QueryFoldersService = class QueryFoldersService {
    async getFolders(user, appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const orgId = user.organizationId;
            const folders = await manager.query(
                `SELECT qf.*,
                    (SELECT COUNT(*)::int FROM data_queries dq WHERE dq.folder_id = qf.id) as query_count
                 FROM query_folders qf
                 WHERE qf.app_version_id = $1 AND qf.organization_id = $2
                 ORDER BY qf.name ASC`,
                [appVersionId, orgId]
            );
            return { folders };
        });
    }

    async getQueryFolderMap(appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const queries = await manager.query(
                `SELECT id, name, folder_id FROM data_queries
                 WHERE app_version_id = $1
                 ORDER BY name ASC`,
                [appVersionId]
            );
            return { queries };
        });
    }

    async createFolder(user, dto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const orgId = user.organizationId;
            const result = await manager.query(
                `INSERT INTO query_folders (name, parent_id, app_version_id, organization_id)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [dto.name, dto.parent_id || null, dto.app_version_id, orgId]
            );
            return { folder: result[0] };
        });
    }

    async updateFolder(user, id, dto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const orgId = user.organizationId;
            if (dto.parent_id === id) {
                throw new Error('A folder cannot be its own parent');
            }
            if (dto.parent_id) {
                const descendants = await this.getDescendantIds(manager, id);
                if (descendants.includes(dto.parent_id)) {
                    throw new Error('Cannot move a folder into its own descendant');
                }
            }
            const result = await manager.query(
                `UPDATE query_folders
                 SET name = $1, parent_id = $2, updated_at = NOW()
                 WHERE id = $3 AND organization_id = $4
                 RETURNING *`,
                [dto.name, dto.parent_id !== undefined ? dto.parent_id : null, id, orgId]
            );
            if (!result.length) {
                throw new Error('Folder not found');
            }
            return { folder: result[0] };
        });
    }

    async deleteFolder(user, id) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const orgId = user.organizationId;
            const descendantIds = await this.getDescendantIds(manager, id);
            const allIds = [id, ...descendantIds];
            const placeholders = allIds.map((_, i) => `$${i + 1}`).join(',');
            await manager.query(
                `UPDATE data_queries SET folder_id = NULL WHERE folder_id IN (${placeholders})`,
                allIds
            );
            await manager.query(
                'DELETE FROM query_folders WHERE id = $1 AND organization_id = $2',
                [id, orgId]
            );
            return { success: true };
        });
    }

    async moveQuery(queryId, folderId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await manager.query('UPDATE data_queries SET folder_id = $1 WHERE id = $2', [
                folderId || null,
                queryId,
            ]);
            return { success: true };
        });
    }

    async moveQueriesBulk(queryIds, folderId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const placeholders = queryIds.map((_, i) => `$${i + 2}`).join(',');
            await manager.query(
                `UPDATE data_queries SET folder_id = $1 WHERE id IN (${placeholders})`,
                [folderId || null, ...queryIds]
            );
            return { success: true };
        });
    }

    async ensureDefaultFolder(user, appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const orgId = user.organizationId;

            // Check if this version already has folders
            const existingFolders = await manager.query(
                `SELECT id FROM query_folders WHERE app_version_id = $1 AND organization_id = $2 LIMIT 1`,
                [appVersionId, orgId]
            );

            if (existingFolders.length === 0) {
                // No folders for this version — try to clone from a previous version
                const cloned = await this.cloneFoldersFromPreviousVersion(manager, appVersionId, orgId);
                if (cloned) {
                    return { folder: null, cloned: true };
                }
            }

            // Find or create "Ungrouped" default folder
            let rows = await manager.query(
                `SELECT * FROM query_folders
                 WHERE name = 'Ungrouped' AND app_version_id = $1 AND organization_id = $2 AND parent_id IS NULL`,
                [appVersionId, orgId]
            );
            let defaultFolder;
            if (rows.length === 0) {
                const inserted = await manager.query(
                    `INSERT INTO query_folders (name, parent_id, app_version_id, organization_id)
                     VALUES ('Ungrouped', NULL, $1, $2)
                     ON CONFLICT ON CONSTRAINT uq_query_folder_name DO NOTHING
                     RETURNING *`,
                    [appVersionId, orgId]
                );
                defaultFolder = inserted.length > 0 ? inserted[0] : (await manager.query(
                    `SELECT * FROM query_folders
                     WHERE name = 'Ungrouped' AND app_version_id = $1 AND organization_id = $2 AND parent_id IS NULL`,
                    [appVersionId, orgId]
                ))[0];
            } else {
                defaultFolder = rows[0];
            }

            // Assign unassigned queries to default folder
            await manager.query(
                `UPDATE data_queries SET folder_id = $1
                 WHERE app_version_id = $2 AND (folder_id IS NULL)`,
                [defaultFolder.id, appVersionId]
            );
            return { folder: defaultFolder };
        });
    }

    async cloneFoldersFromPreviousVersion(manager, appVersionId, orgId) {
        // Find the app_id for this version
        const versionRows = await manager.query(
            `SELECT app_id FROM app_versions WHERE id = $1`, [appVersionId]
        );
        if (versionRows.length === 0) return false;
        const appId = versionRows[0].app_id;

        // Find the most recent version of this app that HAS folders (not current version)
        const sourceRows = await manager.query(
            `SELECT DISTINCT qf.app_version_id
             FROM query_folders qf
             JOIN app_versions av ON av.id = qf.app_version_id
             WHERE av.app_id = $1 AND qf.app_version_id != $2 AND qf.organization_id = $3
             ORDER BY qf.app_version_id
             LIMIT 1`,
            [appId, appVersionId, orgId]
        );
        if (sourceRows.length === 0) return false;
        const sourceVersionId = sourceRows[0].app_version_id;

        // Get all folders from source version (ordered to process parents first)
        const sourceFolders = await manager.query(
            `SELECT * FROM query_folders
             WHERE app_version_id = $1 AND organization_id = $2
             ORDER BY parent_id NULLS FIRST, name`,
            [sourceVersionId, orgId]
        );
        if (sourceFolders.length === 0) return false;

        // Clone folders, mapping old IDs to new IDs
        const idMap = {}; // oldFolderId -> newFolderId
        for (const folder of sourceFolders) {
            const newParentId = folder.parent_id ? (idMap[folder.parent_id] || null) : null;
            const inserted = await manager.query(
                `INSERT INTO query_folders (name, parent_id, app_version_id, organization_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT ON CONSTRAINT uq_query_folder_name DO NOTHING
                 RETURNING *`,
                [folder.name, newParentId, appVersionId, orgId]
            );
            if (inserted.length > 0) {
                idMap[folder.id] = inserted[0].id;
            }
        }

        // Map queries to folders by matching query names between versions
        const sourceQueries = await manager.query(
            `SELECT name, folder_id FROM data_queries
             WHERE app_version_id = $1 AND folder_id IS NOT NULL`,
            [sourceVersionId]
        );

        for (const sq of sourceQueries) {
            const newFolderId = idMap[sq.folder_id];
            if (!newFolderId) continue;
            await manager.query(
                `UPDATE data_queries SET folder_id = $1
                 WHERE app_version_id = $2 AND name = $3 AND folder_id IS NULL`,
                [newFolderId, appVersionId, sq.name]
            );
        }

        return true;
    }

    async getDescendantIds(manager, folderId) {
        const result = await manager.query(
            `WITH RECURSIVE descendants AS (
                SELECT id FROM query_folders WHERE parent_id = $1
                UNION ALL
                SELECT qf.id FROM query_folders qf
                INNER JOIN descendants d ON qf.parent_id = d.id
            )
            SELECT id FROM descendants`,
            [folderId]
        );
        return result.map((r) => r.id);
    }
};
QueryFoldersService = __decorate([
    (0, common_1.Injectable)()
], QueryFoldersService);
exports.QueryFoldersService = QueryFoldersService;
