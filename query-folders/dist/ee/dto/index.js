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
exports.MoveQueriesBulkDto = exports.MoveQueryDto = exports.UpdateQueryFolderDto = exports.CreateQueryFolderDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");

class CreateQueryFolderDto {
}
exports.CreateQueryFolderDto = CreateQueryFolderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: "Folder name can't be empty" }),
    (0, class_validator_1.MaxLength)(50, { message: 'Maximum length has been reached.' }),
    (0, class_transformer_1.Transform)(({ value }) => value?.trim()),
    __metadata("design:type", String)
], CreateQueryFolderDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateQueryFolderDto.prototype, "parent_id", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], CreateQueryFolderDto.prototype, "app_version_id", void 0);

class UpdateQueryFolderDto {
}
exports.UpdateQueryFolderDto = UpdateQueryFolderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)({ message: "Folder name can't be empty" }),
    (0, class_validator_1.MaxLength)(50, { message: 'Maximum length has been reached.' }),
    (0, class_transformer_1.Transform)(({ value }) => value?.trim()),
    __metadata("design:type", String)
], UpdateQueryFolderDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], UpdateQueryFolderDto.prototype, "parent_id", void 0);

class MoveQueryDto {
}
exports.MoveQueryDto = MoveQueryDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], MoveQueryDto.prototype, "query_id", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], MoveQueryDto.prototype, "folder_id", void 0);

class MoveQueriesBulkDto {
}
exports.MoveQueriesBulkDto = MoveQueriesBulkDto;
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.IsUUID)('4', { each: true }),
    __metadata("design:type", Array)
], MoveQueriesBulkDto.prototype, "query_ids", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], MoveQueriesBulkDto.prototype, "folder_id", void 0);
