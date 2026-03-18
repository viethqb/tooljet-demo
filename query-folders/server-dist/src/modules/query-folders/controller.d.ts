import { QueryFoldersService } from './service';
import { CreateQueryFolderDto, UpdateQueryFolderDto, MoveQueryToFolderDto } from './dto';
export declare class QueryFoldersController {
    protected queryFoldersService: QueryFoldersService;
    constructor(queryFoldersService: QueryFoldersService);
    getAll(appVersionId: string): Promise<any>;
    create(createDto: CreateQueryFolderDto): Promise<any>;
    update(id: string, updateDto: UpdateQueryFolderDto): Promise<any>;
    delete(id: string): Promise<any>;
    moveQuery(id: string, moveDto: MoveQueryToFolderDto): Promise<any>;
}
