import { SubModule } from '@modules/app/sub-module';
import { DynamicModule } from '@nestjs/common';
export declare class QueryFoldersModule extends SubModule {
    static register(configs?: {
        IS_GET_CONTEXT: boolean;
    }): Promise<DynamicModule>;
}
