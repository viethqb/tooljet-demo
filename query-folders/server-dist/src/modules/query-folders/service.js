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
const query_folder_entity_1 = require("../../entities/query_folder.entity");
const data_query_entity_1 = require("../../entities/data_query.entity");
const humps_1 = require("humps");
const database_helper_1 = require("../../helpers/database.helper");
let QueryFoldersService = class QueryFoldersService {
    async getAll(appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const folders = await manager.find(query_folder_entity_1.QueryFolder, {
                where: { appVersionId },
                order: { position: 'ASC' },
            });
            return { query_folders: folders.map((f) => (0, humps_1.decamelizeKeys)(f)) };
        });
    }
    async create(createDto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            var _a;
            const maxPosition = await manager
                .createQueryBuilder(query_folder_entity_1.QueryFolder, 'qf')
                .select('COALESCE(MAX(qf.position), -1)', 'max')
                .where('qf.app_version_id = :appVersionId', { appVersionId: createDto.app_version_id })
                .getRawOne();
            const folder = manager.create(query_folder_entity_1.QueryFolder, {
                name: createDto.name,
                appVersionId: createDto.app_version_id,
                position: (_a = createDto.position) !== null && _a !== void 0 ? _a : (maxPosition.max + 1),
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const saved = await manager.save(folder);
            return (0, humps_1.decamelizeKeys)(saved);
        });
    }
    async update(id, updateDto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            const updateData = {};
            if (updateDto.name !== undefined)
                updateData.name = updateDto.name;
            if (updateDto.position !== undefined)
                updateData.position = updateDto.position;
            updateData.updatedAt = new Date();
            await manager.update(query_folder_entity_1.QueryFolder, { id }, updateData);
            const updated = await manager.findOneOrFail(query_folder_entity_1.QueryFolder, { where: { id } });
            return (0, humps_1.decamelizeKeys)(updated);
        });
    }
    async delete(id) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await manager.delete(query_folder_entity_1.QueryFolder, { id });
            return { statusCode: 200, message: 'Folder deleted' };
        });
    }
    async moveQuery(moveDto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            var _a;
            const updateData = {
                queryFolderId: moveDto.folder_id || null,
                folderPosition: (_a = moveDto.position) !== null && _a !== void 0 ? _a : 0,
                updatedAt: new Date(),
            };
            await manager.update(data_query_entity_1.DataQuery, { id: moveDto.query_id }, updateData);
            return (0, humps_1.decamelizeKeys)(updateData);
        });
    }
};
exports.QueryFoldersService = QueryFoldersService;
exports.QueryFoldersService = QueryFoldersService = __decorate([
    (0, common_1.Injectable)()
], QueryFoldersService);
//# sourceMappingURL=service.js.map