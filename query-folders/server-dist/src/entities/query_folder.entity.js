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
exports.QueryFolder = void 0;
const typeorm_1 = require("typeorm");
const app_version_entity_1 = require("./app_version.entity");
const data_query_entity_1 = require("./data_query.entity");
let QueryFolder = class QueryFolder extends typeorm_1.BaseEntity {
};
exports.QueryFolder = QueryFolder;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], QueryFolder.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'name', length: 100 }),
    __metadata("design:type", String)
], QueryFolder.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'app_version_id' }),
    __metadata("design:type", String)
], QueryFolder.prototype, "appVersionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'position', type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], QueryFolder.prototype, "position", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ default: () => 'now()', name: 'created_at' }),
    __metadata("design:type", Date)
], QueryFolder.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)({ default: () => 'now()', name: 'updated_at' }),
    __metadata("design:type", Date)
], QueryFolder.prototype, "updatedAt", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => app_version_entity_1.AppVersion, (appVersion) => appVersion.id, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'app_version_id' }),
    __metadata("design:type", app_version_entity_1.AppVersion)
], QueryFolder.prototype, "appVersion", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => data_query_entity_1.DataQuery, (dataQuery) => dataQuery.queryFolder),
    __metadata("design:type", Array)
], QueryFolder.prototype, "dataQueries", void 0);
exports.QueryFolder = QueryFolder = __decorate([
    (0, typeorm_1.Entity)({ name: 'query_folders' })
], QueryFolder);
//# sourceMappingURL=query_folder.entity.js.map