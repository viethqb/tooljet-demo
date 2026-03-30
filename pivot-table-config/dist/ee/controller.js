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
exports.PivotTableConfigController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../src/modules/session/guards/jwt-auth.guard");
const user_decorator_1 = require("../../src/modules/app/decorators/user.decorator");
const service_1 = require("./service");
const dto_1 = require("./dto");

let PivotTableConfigController = class PivotTableConfigController {
    constructor(pivotTableConfigService) {
        this.pivotTableConfigService = pivotTableConfigService;
    }

    // POST /pivot-table-config/detect
    async detectDataSource(user, dto) {
        return this.pivotTableConfigService.detectDataSource(user, dto.app_version_id, dto.component_name);
    }

    // POST /pivot-table-config/execute
    async executePivot(user, dto) {
        return this.pivotTableConfigService.executePivot(user, dto.app_version_id, dto.component_name, dto.config, dto.page, dto.page_size);
    }

    // GET /pivot-table-config/:appVersionId/:componentName
    async getConfig(user, appVersionId, componentName) {
        return this.pivotTableConfigService.getConfig(user, appVersionId, componentName);
    }

    // GET /pivot-table-config/:appVersionId
    async getAllConfigs(user, appVersionId) {
        return this.pivotTableConfigService.getAllConfigs(user, appVersionId);
    }

    // PUT /pivot-table-config
    async upsertConfig(user, dto) {
        return this.pivotTableConfigService.upsertConfig(user, dto);
    }
};
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)('detect'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.DetectDataSourceDto]),
    __metadata("design:returntype", Promise)
], PivotTableConfigController.prototype, "detectDataSource", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)('execute'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.ExecutePivotDto]),
    __metadata("design:returntype", Promise)
], PivotTableConfigController.prototype, "executePivot", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)(':appVersionId/:componentName'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('appVersionId')),
    __param(2, (0, common_1.Param)('componentName')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", Promise)
], PivotTableConfigController.prototype, "getConfig", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)(':appVersionId'),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Param)('appVersionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], PivotTableConfigController.prototype, "getAllConfigs", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)(),
    __param(0, (0, user_decorator_1.User)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dto_1.UpsertPivotConfigDto]),
    __metadata("design:returntype", Promise)
], PivotTableConfigController.prototype, "upsertConfig", null);
PivotTableConfigController = __decorate([
    (0, common_1.Controller)('pivot-table-config'),
    __metadata("design:paramtypes", [service_1.PivotTableConfigService])
], PivotTableConfigController);
exports.PivotTableConfigController = PivotTableConfigController;
