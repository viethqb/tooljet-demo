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
exports.DetectDataSourceDto = exports.ExecutePivotDto = exports.UpsertPivotConfigDto = void 0;
const class_validator_1 = require("class-validator");

class UpsertPivotConfigDto {
}
exports.UpsertPivotConfigDto = UpsertPivotConfigDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], UpsertPivotConfigDto.prototype, "app_version_id", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], UpsertPivotConfigDto.prototype, "component_name", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpsertPivotConfigDto.prototype, "config", void 0);

class DetectDataSourceDto {
}
exports.DetectDataSourceDto = DetectDataSourceDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], DetectDataSourceDto.prototype, "app_version_id", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], DetectDataSourceDto.prototype, "component_name", void 0);

class ExecutePivotDto {
}
exports.ExecutePivotDto = ExecutePivotDto;
__decorate([
    (0, class_validator_1.IsUUID)(),
    __metadata("design:type", String)
], ExecutePivotDto.prototype, "app_version_id", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], ExecutePivotDto.prototype, "component_name", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], ExecutePivotDto.prototype, "config", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], ExecutePivotDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], ExecutePivotDto.prototype, "page_size", void 0);
