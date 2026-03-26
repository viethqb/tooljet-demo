"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PivotTableConfigModule = void 0;
const sub_module_1 = require("../app/sub-module");
class PivotTableConfigModule extends sub_module_1.SubModule {
    static async register(configs) {
        const { PivotTableConfigController, PivotTableConfigService } = await this.getProviders(configs, 'pivot-table-config', [
            'controller',
            'service',
        ]);
        return {
            module: PivotTableConfigModule,
            controllers: [PivotTableConfigController],
            providers: [PivotTableConfigService],
            exports: [PivotTableConfigService],
        };
    }
}
exports.PivotTableConfigModule = PivotTableConfigModule;
