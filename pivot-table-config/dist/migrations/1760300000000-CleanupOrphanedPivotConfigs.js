"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CleanupOrphanedPivotConfigs1760300000000 = void 0;

class CleanupOrphanedPivotConfigs1760300000000 {
    name = 'CleanupOrphanedPivotConfigs1760300000000';

    async up(queryRunner) {
        // Delete orphaned configs where component_id points to a deleted component
        await queryRunner.query(`
            DELETE FROM "pivot_table_configs"
            WHERE "component_id" IS NOT NULL
              AND "component_id" NOT IN (SELECT "id" FROM "components")
        `);

        // Delete orphaned configs where component_name doesn't exist in any page of the app version
        await queryRunner.query(`
            DELETE FROM "pivot_table_configs" ptc
            WHERE "component_id" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "components" c
                JOIN "pages" p ON c.page_id = p.id
                WHERE p.app_version_id = ptc.app_version_id AND c.name = ptc.component_name
              )
        `);

        // Add FK with CASCADE so future deletes auto-cleanup
        await queryRunner.query(`
            ALTER TABLE "pivot_table_configs"
            DROP CONSTRAINT IF EXISTS "fk_pivot_config_component";
            ALTER TABLE "pivot_table_configs"
            ADD CONSTRAINT "fk_pivot_config_component"
            FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE CASCADE
        `);
    }

    async down(queryRunner) {
        await queryRunner.query(`
            ALTER TABLE "pivot_table_configs"
            DROP CONSTRAINT IF EXISTS "fk_pivot_config_component"
        `);
    }
}
exports.CleanupOrphanedPivotConfigs1760300000000 = CleanupOrphanedPivotConfigs1760300000000;
