import { OnModuleInit, MiddlewareConsumer, DynamicModule } from '@nestjs/common';
export declare class AppModule implements OnModuleInit {
    static register(configs: {
        IS_GET_CONTEXT: boolean;
    }): Promise<DynamicModule>;
    configure(consumer: MiddlewareConsumer): void;
    onModuleInit(): void;
}
