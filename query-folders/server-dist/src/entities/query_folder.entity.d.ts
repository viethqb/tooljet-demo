import { BaseEntity } from 'typeorm';
import { AppVersion } from './app_version.entity';
import { DataQuery } from './data_query.entity';
export declare class QueryFolder extends BaseEntity {
    id: string;
    name: string;
    appVersionId: string;
    position: number;
    createdAt: Date;
    updatedAt: Date;
    appVersion: AppVersion;
    dataQueries: DataQuery[];
}
