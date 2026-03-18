"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateQueryFolders1754300000000 = void 0;
class CreateQueryFolders1754300000000 {
    async up(queryRunner) {
        await queryRunner.query(`
      CREATE TABLE query_folders (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        name varchar(100) NOT NULL,
        app_version_id uuid NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
        position integer NOT NULL DEFAULT 0,
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
      )
    `);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP TABLE IF EXISTS query_folders`);
    }
}
exports.CreateQueryFolders1754300000000 = CreateQueryFolders1754300000000;
//# sourceMappingURL=1754300000000-CreateQueryFolders.js.map