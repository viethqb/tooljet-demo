"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddQueryFolderIdToDataQueries1754300100000 = void 0;
class AddQueryFolderIdToDataQueries1754300100000 {
    async up(queryRunner) {
        await queryRunner.query(`
      ALTER TABLE data_queries
      ADD COLUMN query_folder_id uuid REFERENCES query_folders(id) ON DELETE SET NULL,
      ADD COLUMN folder_position integer DEFAULT 0
    `);
    }
    async down(queryRunner) {
        await queryRunner.query(`
      ALTER TABLE data_queries
      DROP COLUMN IF EXISTS folder_position,
      DROP COLUMN IF EXISTS query_folder_id
    `);
    }
}
exports.AddQueryFolderIdToDataQueries1754300100000 = AddQueryFolderIdToDataQueries1754300100000;
//# sourceMappingURL=1754300100000-AddQueryFolderIdToDataQueries.js.map