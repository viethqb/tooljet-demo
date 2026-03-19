"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateQueryFolders1760000000000 = void 0;
const typeorm_1 = require("typeorm");

class CreateQueryFolders1760000000000 {
    name = 'CreateQueryFolders1760000000000';

    async up(queryRunner) {
        // Create query_folders table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "query_folders" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "name" character varying(255) NOT NULL,
                "parent_id" uuid,
                "app_version_id" uuid NOT NULL,
                "organization_id" uuid NOT NULL,
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_query_folders" PRIMARY KEY ("id"),
                CONSTRAINT "uq_query_folder_name" UNIQUE ("name", "parent_id", "app_version_id"),
                CONSTRAINT "FK_query_folder_parent" FOREIGN KEY ("parent_id") REFERENCES "query_folders"("id") ON DELETE CASCADE
            )
        `);

        // Add folder_id column to data_queries
        const hasColumn = await queryRunner.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'data_queries' AND column_name = 'folder_id'
        `);

        if (hasColumn.length === 0) {
            await queryRunner.query(`
                ALTER TABLE "data_queries" ADD COLUMN "folder_id" uuid
            `);
            await queryRunner.query(`
                ALTER TABLE "data_queries" ADD CONSTRAINT "FK_data_queries_folder"
                FOREIGN KEY ("folder_id") REFERENCES "query_folders"("id") ON DELETE SET NULL
            `);
        }

        // Create indexes
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_query_folders_app_version" ON "query_folders"("app_version_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_query_folders_parent" ON "query_folders"("parent_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_query_folders_org" ON "query_folders"("organization_id")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_data_queries_folder" ON "data_queries"("folder_id")`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "data_queries" DROP CONSTRAINT IF EXISTS "FK_data_queries_folder"`);
        await queryRunner.query(`ALTER TABLE "data_queries" DROP COLUMN IF EXISTS "folder_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "query_folders"`);
    }
}
exports.CreateQueryFolders1760000000000 = CreateQueryFolders1760000000000;
