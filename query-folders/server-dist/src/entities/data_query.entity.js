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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataQuery = void 0;
const typeorm_1 = require("typeorm");
const app_entity_1 = require("./app.entity");
const app_version_entity_1 = require("./app_version.entity");
const data_source_entity_1 = require("./data_source.entity");
const plugin_entity_1 = require("./plugin.entity");
const query_permissions_entity_1 = require("./query_permissions.entity");
const query_folder_entity_1 = require("./query_folder.entity");
let DataQuery = class DataQuery extends typeorm_1.BaseEntity {
    updatePlugin() {
        var _a;
        if ((_a = this.plugins) === null || _a === void 0 ? void 0 : _a.length)
            this.plugin = this.plugins[0];
    }
    updateKind() {
        var _a;
        this.kind = (_a = this.dataSource) === null || _a === void 0 ? void 0 : _a.kind;
    }
    updateApp() {
        var _a;
        if ((_a = this.apps) === null || _a === void 0 ? void 0 : _a.length)
            this.app = this.apps[0];
    }
};
exports.DataQuery = DataQuery;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], DataQuery.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'name' }),
    __metadata("design:type", String)
], DataQuery.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)('simple-json', { name: 'options' }),
    __metadata("design:type", Object)
], DataQuery.prototype, "options", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'data_source_id' }),
    __metadata("design:type", String)
], DataQuery.prototype, "dataSourceId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'app_version_id' }),
    __metadata("design:type", String)
], DataQuery.prototype, "appVersionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'query_folder_id', nullable: true }),
    __metadata("design:type", String)
], DataQuery.prototype, "queryFolderId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'folder_position', type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], DataQuery.prototype, "folderPosition", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ default: () => 'now()', name: 'created_at' }),
    __metadata("design:type", Date)
], DataQuery.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ default: () => 'now()', name: 'updated_at' }),
    __metadata("design:type", Date)
], DataQuery.prototype, "updatedAt", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => data_source_entity_1.DataSource, (dataSource) => dataSource.id, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'data_source_id' }),
    __metadata("design:type", data_source_entity_1.DataSource)
], DataQuery.prototype, "dataSource", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => app_version_entity_1.AppVersion, (appVersion) => appVersion.id, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'app_version_id' }),
    __metadata("design:type", app_version_entity_1.AppVersion)
], DataQuery.prototype, "appVersion", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => query_folder_entity_1.QueryFolder, (queryFolder) => queryFolder.dataQueries, { onDelete: 'SET NULL' }),
    (0, typeorm_1.JoinColumn)({ name: 'query_folder_id' }),
    __metadata("design:type", query_folder_entity_1.QueryFolder)
], DataQuery.prototype, "queryFolder", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => plugin_entity_1.Plugin),
    (0, typeorm_1.JoinTable)({
        name: 'data_sources',
        joinColumn: {
            name: 'id',
            referencedColumnName: 'dataSourceId',
        },
        inverseJoinColumn: {
            name: 'plugin_id',
            referencedColumnName: 'id',
        },
    }),
    __metadata("design:type", Array)
], DataQuery.prototype, "plugins", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => app_entity_1.App),
    (0, typeorm_1.JoinTable)({
        name: 'app_versions',
        joinColumn: {
            name: 'id',
            referencedColumnName: 'appVersionId',
        },
        inverseJoinColumn: {
            name: 'app_id',
            referencedColumnName: 'id',
        },
    }),
    __metadata("design:type", Array)
], DataQuery.prototype, "apps", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => query_permissions_entity_1.QueryPermission, (permission) => permission.query),
    __metadata("design:type", Array)
], DataQuery.prototype, "permissions", void 0);
__decorate([
    (0, typeorm_1.AfterLoad)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DataQuery.prototype, "updatePlugin", null);
__decorate([
    (0, typeorm_1.AfterLoad)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DataQuery.prototype, "updateKind", null);
__decorate([
    (0, typeorm_1.AfterLoad)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], DataQuery.prototype, "updateApp", null);
exports.DataQuery = DataQuery = __decorate([
    (0, typeorm_1.Entity)({ name: 'data_queries' })
], DataQuery);
//# sourceMappingURL=data_query.entity.js.map