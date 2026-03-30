"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddComponentIdToPivotConfig1760200000000 = void 0;

class AddComponentIdToPivotConfig1760200000000 {
    name = 'AddComponentIdToPivotConfig1760200000000';

    async up(queryRunner) {
        // Add component_id column (nullable for backward compatibility with existing rows)
        await queryRunner.query(`
            ALTER TABLE "pivot_table_configs"
            ADD COLUMN IF NOT EXISTS "component_id" uuid
        `);

        // Backfill: resolve component_id from component_name for existing rows
        await queryRunner.query(`
            UPDATE "pivot_table_configs" ptc
            SET "component_id" = c.id
            FROM "components" c
            JOIN "pages" p ON c.page_id = p.id
            WHERE p.app_version_id = ptc.app_version_id
              AND c.name = ptc.component_name
              AND ptc.component_id IS NULL
        `);

        // Create unique constraint on (app_version_id, component_id) for rows that have component_id
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "uq_pivot_config_version_component_id"
            ON "pivot_table_configs"("app_version_id", "component_id")
            WHERE "component_id" IS NOT NULL
        `);

        // Index for fast lookup by component_id
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_pivot_config_component_id"
            ON "pivot_table_configs"("component_id")
            WHERE "component_id" IS NOT NULL
        `);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_pivot_config_component_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "uq_pivot_config_version_component_id"`);
        await queryRunner.query(`ALTER TABLE "pivot_table_configs" DROP COLUMN IF EXISTS "component_id"`);
    }
}
exports.AddComponentIdToPivotConfig1760200000000 = AddComponentIdToPivotConfig1760200000000;
