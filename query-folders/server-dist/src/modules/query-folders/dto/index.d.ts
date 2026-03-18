export declare class CreateQueryFolderDto {
    name: string;
    app_version_id: string;
    position: number;
}
export declare class UpdateQueryFolderDto {
    name: string;
    position: number;
}
export declare class MoveQueryToFolderDto {
    query_id: string;
    folder_id: string;
    position: number;
}
