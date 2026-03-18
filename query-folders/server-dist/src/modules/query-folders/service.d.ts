import { CreateQueryFolderDto, UpdateQueryFolderDto, MoveQueryToFolderDto } from './dto';
export declare class QueryFoldersService {
    getAll(appVersionId: string): Promise<any>;
    create(createDto: CreateQueryFolderDto): Promise<any>;
    update(id: string, updateDto: UpdateQueryFolderDto): Promise<any>;
    delete(id: string): Promise<any>;
    moveQuery(moveDto: MoveQueryToFolderDto): Promise<any>;
}
