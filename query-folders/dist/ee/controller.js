"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryFoldersController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../src/modules/session/guards/jwt-auth.guard");
const user_decorator_1 = require("../../src/modules/app/decorators/user.decorator");
const service_1 = require("./service");
const dto_1 = require("./dto");

let QueryFoldersController = class QueryFoldersController {
    constructor(queryFoldersService) {
        this.queryFoldersService = queryFoldersService;
    }
    async getQueryFolderMap(user, appVersionId) {
        return this.queryFoldersService.getQueryFolderMap(user, appVersionId);
    }
    async getFolders(user, appVersionId) {
        return this.queryFoldersService.getFolders(user, appVersionId);
    }
    async createFolder(user, dto) {
        try {
            return await this.queryFoldersService.createFolder(user, dto);
        }
        catch (err) {
            if (err.constraint === 'uq_query_folder_name') {
                throw new common_1.HttpException('A folder with this name already exists at this level', common_1.HttpStatus.CONFLICT);
            }
            throw new common_1.HttpException(err.message || 'Failed to create folder', common_1.HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
    async ensureDefaultFolder(user, appVersionId) {
        return this.queryFoldersService.ensureDefaultFolder(user, appVersionId);
    }
    async moveQuery(user, dto) {
        return this.queryFoldersService.moveQuery(user, dto.query_id, dto.folder_id || null);
    }
    async moveQueriesBulk(user, dto) {
        return this.queryFoldersService.moveQueriesBulk(user, dto.query_ids, dto.folder_id || null);
    }
    async updateFolder(user, id, dto) {
        try {
            return await this.queryFoldersService.updateFolder(user, id, dto);
        }
        catch (err) {
            if (err.constraint === 'uq_query_folder_name') {
                throw new common_1.HttpException('A folder with this name already exists at this level', common_1.HttpStatus.CONFLICT);
            }
            if (err.message && err.message.includes('not found')) {
                throw new common_1.HttpException('Folder not found', common_1.HttpStatus.NOT_FOUND);
            }
            throw new common_1.HttpException(err.message || 'Failed to update folder', common_1.HttpStatus.BAD_REQUEST);
        }
    }
    async deleteFolder(user, id) {
        return this.queryFoldersService.deleteFolder(user, id);
    }
};
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('queries/:appVersionId'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('appVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "getQueryFolderMap", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)(':appVersionId'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('appVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "getFolders", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)(),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.CreateQueryFolderDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "createFolder", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)('ensure-default/:appVersionId'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('appVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "ensureDefaultFolder", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)('move-query'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.MoveQueryDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "moveQuery", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)('move-queries-bulk'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.MoveQueriesBulkDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "moveQueriesBulk", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)(':id'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, dto_1.UpdateQueryFolderDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "updateFolder", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Delete)(':id'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "deleteFolder", null);
QueryFoldersController = __decorate([
    (0, common_1.Controller)('query-folders'),
    __metadata("design:paramtypes", [service_1.QueryFoldersService])
], QueryFoldersController);
exports.QueryFoldersController = QueryFoldersController;
