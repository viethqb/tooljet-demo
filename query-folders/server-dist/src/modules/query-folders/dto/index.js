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
exports.MoveQueryToFolderDto = exports.UpdateQueryFolderDto = exports.CreateQueryFolderDto = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const utils_helper_1 = require("../../../helpers/utils.helper");
class CreateQueryFolderDto {
}
exports.CreateQueryFolderDto = CreateQueryFolderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_transformer_1.Transform)(({ value }) => (0, utils_helper_1.sanitizeInput)(value)),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], CreateQueryFolderDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateQueryFolderDto.prototype, "app_version_id", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], CreateQueryFolderDto.prototype, "position", void 0);
class UpdateQueryFolderDto {
}
exports.UpdateQueryFolderDto = UpdateQueryFolderDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Transform)(({ value }) => (0, utils_helper_1.sanitizeInput)(value)),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], UpdateQueryFolderDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], UpdateQueryFolderDto.prototype, "position", void 0);
class MoveQueryToFolderDto {
}
exports.MoveQueryToFolderDto = MoveQueryToFolderDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], MoveQueryToFolderDto.prototype, "query_id", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], MoveQueryToFolderDto.prototype, "folder_id", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Number)
], MoveQueryToFolderDto.prototype, "position", void 0);
//# sourceMappingURL=index.js.map