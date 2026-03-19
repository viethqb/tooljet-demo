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
                if (inserted.length > 0) {
                    defaultFolder = inserted[0];
                } else {
                    // Was created by a concurrent request
                    rows = await manager.query(
                        `SELECT * FROM query_folders
                         WHERE name = 'Ungrouped' AND app_version_id = $1 AND organization_id = $2 AND parent_id IS NULL`,
                        [appVersionId, orgId]
                    );
                    defaultFolder = rows[0];
                }
            } else {
                defaultFolder = rows[0];
            }
            // Assign all unassigned queries to the default folder
            await manager.query(
                `UPDATE data_queries SET folder_id = $1
                 WHERE app_version_id = $2 AND (folder_id IS NULL)`,
                [defaultFolder.id, appVersionId]
            );
            return { folder: defaultFolder };
        });
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
