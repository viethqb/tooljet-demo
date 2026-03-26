"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreatePivotTableConfig1760100000000 = void 0;

class CreatePivotTableConfig1760100000000 {
    name = 'CreatePivotTableConfig1760100000000';

    async up(queryRunner) {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "pivot_table_configs" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "app_version_id" uuid NOT NULL,
                "component_name" character varying(255) NOT NULL,
                "config" jsonb NOT NULL DEFAULT '{}',
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_pivot_table_configs" PRIMARY KEY ("id"),
                CONSTRAINT "uq_pivot_config_version_component" UNIQUE ("app_version_id", "component_name")
            )
        `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_pivot_config_app_version" ON "pivot_table_configs"("app_version_id")`);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP TABLE IF EXISTS "pivot_table_configs"`);
    }
}
exports.CreatePivotTableConfig1760100000000 = CreatePivotTableConfig1760100000000;
