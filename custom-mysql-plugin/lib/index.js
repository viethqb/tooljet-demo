"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const knex_1 = __importDefault(require("knex"));
const common_1 = require("@tooljet-plugins/common");
const common_2 = require("@tooljet-plugins/common");
class MysqlQueryService {
    constructor() {
        var _a, _b;
        this.STATEMENT_TIMEOUT =
            ((_a = process.env) === null || _a === void 0 ? void 0 : _a.PLUGINS_SQL_DB_STATEMENT_TIMEOUT) && !isNaN(Number((_b = process.env) === null || _b === void 0 ? void 0 : _b.PLUGINS_SQL_DB_STATEMENT_TIMEOUT))
                ? Number(process.env.PLUGINS_SQL_DB_STATEMENT_TIMEOUT)
                : 120000;
        if (MysqlQueryService._instance) {
            return MysqlQueryService._instance;
        }
        MysqlQueryService._instance = this;
        return MysqlQueryService._instance;
    }
    run(sourceOptions, queryOptions, dataSourceId, dataSourceUpdatedAt) {
        return __awaiter(this, void 0, void 0, function* () {
            let checkCache, knexInstance;
            if (sourceOptions['allow_dynamic_connection_parameters']) {
                if (sourceOptions.connection_type === 'hostname') {
                    sourceOptions['host'] = queryOptions['host'] ? queryOptions['host'] : sourceOptions['host'];
                    sourceOptions['database'] = queryOptions['database'] ? queryOptions['database'] : sourceOptions['database'];
                }
                else if (sourceOptions.connection_type === 'socket_path') {
                    sourceOptions['database'] = queryOptions['database'] ? queryOptions['database'] : sourceOptions['database'];
                }
            }
            try {
                // Always disable connection caching and destroy connection after query to avoid connection pool
                checkCache = false;
                knexInstance = yield this.getConnection(sourceOptions, {}, checkCache, dataSourceId, dataSourceUpdatedAt);
                switch (queryOptions.mode) {
                    case 'sql':
                        return yield this.handleRawQuery(knexInstance, queryOptions);
                    case 'gui':
                        return yield this.handleGuiQuery(knexInstance, queryOptions);
                    default:
                        throw new Error("Invalid query mode. Must be either 'sql' or 'gui'.");
                }
            }
            catch (err) {
                const errorMessage = err.message || 'An unknown error occurred';
                const errorDetails = {};
                if (err instanceof Error) {
                    const mysqlError = err;
                    const { code, errno, sqlMessage, sqlState } = mysqlError;
                    errorDetails.code = code || null;
                    errorDetails.errno = errno || null;
                    errorDetails.sqlMessage = sqlMessage || null;
                    errorDetails.sqlState = sqlState || null;
                }
                throw new common_1.QueryError('Query could not be completed', errorMessage, errorDetails);
            }
            finally {
                if (knexInstance)
                    yield knexInstance.destroy();
            }
        });
    }
    testConnection(sourceOptions) {
        return __awaiter(this, void 0, void 0, function* () {
            const knexInstance = yield this.getConnection(sourceOptions, {}, false);
            yield knexInstance.raw('select @@version;').timeout(this.STATEMENT_TIMEOUT);
            knexInstance.destroy();
            return { status: 'ok' };
        });
    }
    handleGuiQuery(knexInstance, queryOptions) {
        return __awaiter(this, void 0, void 0, function* () {
            if (queryOptions.operation !== 'bulk_update_pkey') {
                return { rows: [] };
            }
            const query = this.buildBulkUpdateQuery(queryOptions);
            return yield this.executeQuery(knexInstance, query);
        });
    }
    handleRawQuery(knexInstance, queryOptions) {
        return __awaiter(this, void 0, void 0, function* () {
            const { query, query_params } = queryOptions;
            const queryParams = query_params || [];
            const sanitizedQueryParams = Object.fromEntries(queryParams.filter(([key]) => !(0, common_2.isEmpty)(key)));
            const result = yield this.executeQuery(knexInstance, query, sanitizedQueryParams);
            return { status: 'ok', data: result[0] };
        });
    }
    executeQuery(knexInstance, query, sanitizedQueryParams = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            if ((0, common_2.isEmpty)(query))
                throw new Error('Query is empty');
            const result = yield knexInstance.raw(query, sanitizedQueryParams).timeout(this.STATEMENT_TIMEOUT);
            return result;
        });
    }
    connectionOptions(sourceOptions) {
        const _connectionOptions = ((sourceOptions === null || sourceOptions === void 0 ? void 0 : sourceOptions.connection_options) || []).filter((o) => o.some((e) => !(0, common_2.isEmpty)(e)));
        const connectionOptions = Object.fromEntries(_connectionOptions);
        Object.keys(connectionOptions).forEach((key) => connectionOptions[key] === '' ? delete connectionOptions[key] : {});
        return connectionOptions;
    }
    buildConnection(sourceOptions) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const props = sourceOptions.socket_path
                ? { socketPath: sourceOptions.socket_path }
                : {
                    host: sourceOptions.host,
                    port: +sourceOptions.port,
                    ssl: (_a = sourceOptions.ssl_enabled) !== null && _a !== void 0 ? _a : false,
                };
            const sslObject = { rejectUnauthorized: ((_b = sourceOptions.ssl_certificate) !== null && _b !== void 0 ? _b : 'none') != 'none' };
            if (sourceOptions.ssl_certificate === 'ca_certificate') {
                sslObject['ca'] = sourceOptions.ca_cert;
            }
            if (sourceOptions.ssl_certificate === 'self_signed') {
                sslObject['ca'] = sourceOptions.root_cert;
                sslObject['key'] = sourceOptions.client_key;
                sslObject['cert'] = sourceOptions.client_cert;
            }
            const config = Object.assign({ client: 'mysql2', connection: Object.assign(Object.assign(Object.assign({}, props), { user: sourceOptions.username, password: sourceOptions.password, database: sourceOptions.database, multipleStatements: true }), (sourceOptions.ssl_enabled && { ssl: sslObject })), pool: { min: 0, max: 1, acquireTimeoutMillis: 60000, idleTimeoutMillis: 30000 } }, this.connectionOptions(sourceOptions));
            return (0, knex_1.default)(config);
        });
    }
    getConnection(sourceOptions, options, checkCache, dataSourceId, dataSourceUpdatedAt) {
        return __awaiter(this, void 0, void 0, function* () {
            if (checkCache) {
                const optionsHash = (0, common_1.generateSourceOptionsHash)(sourceOptions);
                const enhancedCacheKey = `${dataSourceId}_${optionsHash}`;
                const cachedConnection = yield (0, common_1.getCachedConnection)(enhancedCacheKey, dataSourceUpdatedAt);
                if (cachedConnection)
                    return cachedConnection;
                const connection = yield this.buildConnection(sourceOptions);
                (0, common_1.cacheConnectionWithConfiguration)(dataSourceId, enhancedCacheKey, connection);
                return connection;
            }
            return yield this.buildConnection(sourceOptions);
        });
    }
    buildBulkUpdateQuery(queryOptions) {
        let queryText = '';
        const { table: tableName, primary_key_column: primaryKey, records } = queryOptions;
        for (const record of records) {
            const primaryKeyValue = typeof record[primaryKey] === 'string' ? `'${record[primaryKey]}'` : record[primaryKey];
            queryText = `${queryText} UPDATE ${tableName} SET`;
            for (const key of Object.keys(record)) {
                if (key !== primaryKey) {
                    queryText = ` ${queryText} ${key} = '${record[key]}',`;
                }
            }
            queryText = queryText.slice(0, -1);
            queryText = `${queryText} WHERE ${primaryKey} = ${primaryKeyValue};`;
        }
        return queryText.trim();
    }
}
exports.default = MysqlQueryService;
//# sourceMappingURL=index.js.map