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
const jwt_auth_guard_1 = require("../session/guards/jwt-auth.guard");
const service_1 = require("./service");
const dto_1 = require("./dto");
const init_module_1 = require("../app/decorators/init-module");
const modules_1 = require("../app/constants/modules");
let QueryFoldersController = class QueryFoldersController {
    constructor(queryFoldersService) {
        this.queryFoldersService = queryFoldersService;
    }
    async getAll(appVersionId) {
        return this.queryFoldersService.getAll(appVersionId);
    }
    async create(createDto) {
        return this.queryFoldersService.create(createDto);
    }
    async update(id, updateDto) {
        return this.queryFoldersService.update(id, updateDto);
    }
    async delete(id) {
        return this.queryFoldersService.delete(id);
    }
    async moveQuery(id, moveDto) {
        if (!moveDto.folder_id || moveDto.folder_id === 'root') {
            moveDto.folder_id = null;
        }
        return this.queryFoldersService.moveQuery(moveDto);
    }
};
exports.QueryFoldersController = QueryFoldersController;
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)(':appVersionId'),
    __param(0, (0, common_1.Param)('appVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "getAll", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [dto_1.CreateQueryFolderDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "create", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.UpdateQueryFolderDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "update", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "delete", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)(':id/queries'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, dto_1.MoveQueryToFolderDto]),
    __metadata("design:returntype", Promise)
], QueryFoldersController.prototype, "moveQuery", null);
exports.QueryFoldersController = QueryFoldersController = __decorate([
    (0, init_module_1.InitModule)(modules_1.MODULES.QUERY_FOLDERS),
    (0, common_1.Controller)('query-folders'),
    __metadata("design:paramtypes", [service_1.QueryFoldersService])
], QueryFoldersController);
//# sourceMappingURL=controller.js.map