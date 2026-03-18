"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryFoldersModule = void 0;
const sub_module_1 = require("../app/sub-module");
class QueryFoldersModule extends sub_module_1.SubModule {
    static async register(configs) {
        const { QueryFoldersController, QueryFoldersService } = await this.getProviders(configs, 'query-folders', [
            'controller',
            'service',
        ]);
        return {
            module: QueryFoldersModule,
            controllers: [QueryFoldersController],
            providers: [QueryFoldersService],
            exports: [QueryFoldersService],
        };
    }
}
exports.QueryFoldersModule = QueryFoldersModule;
//# sourceMappingURL=module.js.map