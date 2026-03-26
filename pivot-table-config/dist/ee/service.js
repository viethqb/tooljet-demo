"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PivotTableConfigService = void 0;
const common_1 = require("@nestjs/common");
const database_helper_1 = require("../../src/helpers/database.helper");
const crypto = require("crypto");

const AGG_SQL = { count: 'COUNT(*)', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' };
const SQL_KINDS = ['mysql', 'mariadb', 'postgresql', 'mssql', 'oracle', 'starrocks', 'clickhouse', 'bigquery', 'snowflake', 'redshift'];

function escId(name) {
    return '`' + String(name).replace(/`/g, '``').replace(/[\x00-\x1f]/g, '') + '`';
}

// ===================== CREDENTIAL DECRYPTION =====================
// Replicates ToolJet's EncryptionService logic (HKDF + AES-256-GCM)
// Uses LOCKBOX_MASTER_KEY env var — same as ToolJet core

function computeAttributeKey(table, column) {
    var hkdf;
    try { hkdf = require('futoin-hkdf'); } catch (_) {
        // futoin-hkdf is a dependency of ToolJet server, should be available
        throw new Error('futoin-hkdf not found');
    }
    var masterKey = process.env.LOCKBOX_MASTER_KEY;
    if (!masterKey) throw new Error('LOCKBOX_MASTER_KEY not set');

    var key = Buffer.from(masterKey, 'hex');
    var salt = Buffer.alloc(32, '\xb4', 'ascii'); // ´ character = 0xb4
    var info = Buffer.concat([salt, Buffer.from(column + '_ciphertext')]);

    var derived = hkdf(key, 32, { salt: table, info: info, hash: 'sha384' });
    return Buffer.from(derived).toString('hex');
}

function decryptColumnValue(table, column, cipherText) {
    var derivedKey = computeAttributeKey(table, column);
    var key = Buffer.from(derivedKey, 'hex');
    var buf = Buffer.from(cipherText, 'base64');
    var nonce = buf.subarray(0, 12);
    var authTag = buf.subarray(-16);
    var encrypted = buf.subarray(12, -16);
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
}

let PivotTableConfigService = class PivotTableConfigService {

    // ===================== CONFIG CRUD =====================

    async getConfig(appVersionId, componentName) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            var rows = await manager.query(
                `SELECT config FROM pivot_table_configs WHERE app_version_id = $1 AND component_name = $2`,
                [appVersionId, componentName]
            );
            return { config: rows.length > 0 ? rows[0].config : null };
        });
    }

    async getAllConfigs(appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            var rows = await manager.query(
                `SELECT component_name, config FROM pivot_table_configs WHERE app_version_id = $1`,
                [appVersionId]
            );
            var configs = {};
            for (var r of rows) configs[r.component_name] = r.config;
            return { configs };
        });
    }

    async upsertConfig(dto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            var result = await manager.query(
                `INSERT INTO pivot_table_configs (app_version_id, component_name, config)
                 VALUES ($1, $2, $3)
                 ON CONFLICT ON CONSTRAINT uq_pivot_config_version_component
                 DO UPDATE SET config = $3, updated_at = NOW()
                 RETURNING *`,
                [dto.app_version_id, dto.component_name, JSON.stringify(dto.config)]
            );
            return { config: result[0] };
        });
    }

    // ===================== DATASOURCE DETECTION =====================

    async detectDataSource(appVersionId, componentName) {
        var queryInfo = await this._resolveComponentQuery(appVersionId, componentName);
        if (!queryInfo) {
            // Return debug info to help diagnose
            var debug = await this._debugComponentQuery(appVersionId, componentName);
            return { supported: false, kind: null, query_name: null, reason: 'No data query bound to this component', debug: debug };
        }
        var kind = (queryInfo.kind || '').toLowerCase();
        var supported = SQL_KINDS.indexOf(kind) !== -1;
        return {
            supported: supported,
            kind: kind,
            query_name: queryInfo.name,
            reason: supported ? null : 'Datasource "' + kind + '" does not support SQL GROUP BY',
        };
    }

    // ===================== BACKEND PIVOT EXECUTION =====================

    async executePivot(appVersionId, componentName, pivotConfig) {
        // 1. Resolve the data query bound to this component
        var queryInfo = await this._resolveComponentQuery(appVersionId, componentName);
        if (!queryInfo) {
            throw new common_1.HttpException('No data query found for "' + componentName + '"', common_1.HttpStatus.NOT_FOUND);
        }

        var originalSql = this._extractSql(queryInfo.options);
        if (!originalSql) {
            throw new common_1.HttpException('No SQL in query "' + queryInfo.name + '"', common_1.HttpStatus.BAD_REQUEST);
        }

        // 2. Resolve datasource connection credentials (same way ToolJet does)
        var sourceOptions = await this._resolveSourceOptions(queryInfo.data_source_id, appVersionId);

        // 3. Generate pivot SQL
        var pivotSql = this._buildPivotSql(originalSql, pivotConfig);

        // 4. Execute using ToolJet's plugin system (same driver as the datasource)
        try {
            var rows = await this._executeQuery(sourceOptions, pivotSql, queryInfo.kind, queryInfo.data_source_id);
            return { data: rows, query_name: queryInfo.name };
        } catch (err) {
            // Re-throw with debug info
            var debugInfo = {
                message: err.message || err.response?.message || String(err),
                sql: pivotSql,
                original_sql: originalSql,
                kind: queryInfo.kind,
                source_keys: Object.keys(sourceOptions),
            };
            throw new common_1.HttpException(
                'Pivot query failed: ' + JSON.stringify(debugInfo),
                err.status || common_1.HttpStatus.BAD_REQUEST
            );
        }
    }

    // ===================== INTERNAL: RESOLVE COMPONENT → QUERY =====================

    async _resolveComponentQuery(appVersionId, componentName) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            // components table has: name, type, properties (JSON with data binding)
            // joined via: components.page_id → pages.id, pages.app_version_id = $1
            var compRows = await manager.query(
                `SELECT c.name, c.type, c.properties
                 FROM components c
                 JOIN pages p ON c.page_id = p.id
                 WHERE p.app_version_id = $1 AND c.name = $2`,
                [appVersionId, componentName]
            );

            if (compRows.length === 0) return null;

            // Iterate ALL matching components (may have duplicates across pages)
            var queryRef = null;
            for (var ci = 0; ci < compRows.length; ci++) {
                var comp = compRows[ci];
                var props = comp.properties;
                if (typeof props === 'string') { try { props = JSON.parse(props); } catch (_) { continue; } }

                // Extract query reference from dataSourceSelector (primary) or data (fallback)
                var bindingValue = '';
                try { bindingValue = props.dataSourceSelector.value || ''; } catch (_) {}
                if (!bindingValue) {
                    try { bindingValue = props.data.value || ''; } catch (_) {}
                }

                // Match query ID (UUID) or name: {{queries.<ref>.data}}
                var match = String(bindingValue).match(/\{\{\s*queries\.([a-f0-9-]+)\.data/);
                if (!match) match = String(bindingValue).match(/\{\{\s*queries\.(\w+)\.data/);
                if (match) { queryRef = match[1]; break; }
            }
            if (!queryRef) return null;

            // Try lookup by ID first (UUID reference), then by name
            var rows = await manager.query(
                `SELECT dq.id, dq.name, dq.options, dq.data_source_id, ds.kind
                 FROM data_queries dq
                 LEFT JOIN data_sources ds ON dq.data_source_id = ds.id
                 WHERE (dq.id::text = $1 OR dq.name = $1) AND dq.app_version_id = $2
                 LIMIT 1`,
                [queryRef, appVersionId]
            );
            return rows.length > 0 ? rows[0] : null;
        });
    }

    // Debug helper: return raw component info for diagnostics
    async _debugComponentQuery(appVersionId, componentName) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            // Check if component exists at all
            var compRows = await manager.query(
                `SELECT c.name, c.type, LEFT(c.properties::text, 500) as props_preview
                 FROM components c
                 JOIN pages p ON c.page_id = p.id
                 WHERE p.app_version_id = $1
                 ORDER BY c.name`,
                [appVersionId]
            );

            var allNames = compRows.map(function (r) { return r.name + ' (' + r.type + ')'; });

            // Find exact match
            var match = compRows.find(function (r) { return r.name === componentName; });

            return {
                components_found: allNames,
                searched_for: componentName,
                match_found: !!match,
                props_preview: match ? match.props_preview : null,
            };
        });
    }

    // ===================== INTERNAL: RESOLVE DATASOURCE CREDENTIALS =====================

    async _resolveSourceOptions(dataSourceId, appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            // Get the environment this app version is currently using
            var optRows = await manager.query(
                `SELECT dso.options
                 FROM data_source_options dso
                 JOIN app_versions av ON dso.environment_id = av.current_environment_id
                 WHERE dso.data_source_id = $1 AND av.id = $2
                 LIMIT 1`,
                [dataSourceId, appVersionId]
            );
            // Fallback: any environment for this datasource
            if (!optRows || optRows.length === 0) {
                optRows = await manager.query(
                    `SELECT options FROM data_source_options
                     WHERE data_source_id = $1 LIMIT 1`,
                    [dataSourceId]
                );
            }
            if (!optRows || optRows.length === 0) {
                throw new common_1.HttpException('Datasource options not found', common_1.HttpStatus.NOT_FOUND);
            }

            var rawOptions = optRows[0].options;
            if (typeof rawOptions === 'string') rawOptions = JSON.parse(rawOptions);

            // Parse and decrypt each option (same logic as DataSourcesUtilService.parseSourceOptions)
            var parsed = {};
            for (var key of Object.keys(rawOptions)) {
                var opt = rawOptions[key];
                if (opt && typeof opt === 'object') {
                    if (opt.encrypted && opt.credential_id) {
                        // Decrypt: lookup credentials table → decrypt value_ciphertext
                        try {
                            var credRows = await manager.query(
                                `SELECT value_ciphertext FROM credentials WHERE id = $1`, [opt.credential_id]
                            );
                            if (credRows.length > 0 && credRows[0].value_ciphertext) {
                                parsed[key] = decryptColumnValue('credentials', 'value', credRows[0].value_ciphertext);
                            } else {
                                parsed[key] = opt.value || '';
                            }
                        } catch (decErr) {
                            parsed[key] = opt.value || '';
                        }
                    } else {
                        parsed[key] = opt.value !== undefined ? opt.value : '';
                    }
                } else {
                    // Plain value (not wrapped in {value:...})
                    parsed[key] = opt !== undefined ? opt : '';
                }
            }

            // Log raw options structure for debugging
            console.log('[PivotTable] rawOptions keys:', Object.keys(rawOptions).map(function (k) {
                var o = rawOptions[k];
                if (!o || typeof o !== 'object') return k + '=' + o;
                return k + '(' + (o.encrypted ? 'enc:' + (o.credential_id || '?') : 'val:' + String(o.value).substring(0, 30)) + ')';
            }));
            console.log('[PivotTable] parsed sourceOptions:', JSON.stringify(parsed));

            return parsed;
        });
    }

    // ===================== INTERNAL: SQL GENERATION =====================

    _extractSql(options) {
        if (!options) return null;
        var opts = typeof options === 'string' ? JSON.parse(options) : options;
        return opts.query || opts.sql || null;
    }

    _buildPivotSql(originalSql, config) {
        var rowFields = config.rowFields || [];
        var colFields = config.colFields || [];
        var valueField = config.valueField || '';
        var aggregator = config.aggregator || 'count';

        var allGroupFields = rowFields.concat(colFields);
        if (allGroupFields.length === 0) {
            throw new common_1.HttpException('At least one row or column field required', common_1.HttpStatus.BAD_REQUEST);
        }

        var selectParts = allGroupFields.map(function (f) { return escId(f); });
        var aggFunc = AGG_SQL[aggregator] || 'COUNT(*)';

        if (aggregator === 'count' || !valueField) {
            selectParts.push('COUNT(*) AS `_pivot_value`');
        } else {
            selectParts.push(aggFunc + '(' + escId(valueField) + ') AS `_pivot_value`');
        }
        selectParts.push('COUNT(*) AS `_pivot_count`');

        var groupBy = allGroupFields.map(function (f) { return escId(f); });
        var cleanSql = originalSql.replace(/;\s*$/, '');

        return 'SELECT ' + selectParts.join(', ') + '\n' +
            'FROM (\n' + cleanSql + '\n) AS `_pivot_src`\n' +
            'GROUP BY ' + groupBy.join(', ') + '\n' +
            'ORDER BY ' + groupBy.join(', ');
    }

    // ===================== INTERNAL: EXECUTE ON DATASOURCE =====================

    /**
     * Execute SQL using ToolJet's plugin system.
     * Reuses the same drivers and connection logic as ToolJet core.
     * Supports: mysql, postgresql, mariadb, mssql, bigquery, clickhouse, etc.
     */
    async _executeQuery(sourceOptions, sql, kind, dataSourceId) {
        // Load ToolJet plugin system
        var allPlugins;
        var pluginPaths = [
            '/app/plugins/dist/server',
            '@tooljet/plugins/dist/server',
        ];
        for (var pp of pluginPaths) {
            try { allPlugins = require(pp); break; } catch (_) {}
        }
        if (allPlugins && allPlugins.default) allPlugins = allPlugins.default;
        if (!allPlugins || !allPlugins[kind]) {
            throw new common_1.HttpException(
                'Plugin not found for kind "' + kind + '"',
                common_1.HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        // Instantiate plugin service (same as ToolJet's PluginsServiceSelector)
        var service = new allPlugins[kind]();

        // Ensure required connection fields have defaults
        if (!sourceOptions.username && !sourceOptions.user) sourceOptions.username = 'root';
        if (sourceOptions.database === undefined) sourceOptions.database = '';
        if (sourceOptions.port) sourceOptions.port = String(sourceOptions.port);

        console.log('[PivotTable] Executing with plugin:', kind,
            'host:', sourceOptions.host, 'port:', sourceOptions.port,
            'user:', sourceOptions.username || sourceOptions.user,
            'database:', sourceOptions.database);

        // Build query options (same format as ToolJet's MySQL/PG plugins expect)
        var queryOptions = {
            mode: 'sql',
            query: sql,
            query_params: [],
        };

        try {
            var result = await service.run(
                sourceOptions,
                queryOptions,
                dataSourceId || 'pivot-query',   // connection cache key
                new Date().toISOString()          // updatedAt for cache
            );
            if (result.status === 'failed') {
                throw new Error(result.data?.message || result.data?.description || 'Query failed');
            }
            return result.data;
        } catch (err) {
            throw new common_1.HttpException(
                'Pivot query failed: ' + (err.message || err),
                common_1.HttpStatus.BAD_REQUEST
            );
        }
    }
};
PivotTableConfigService = __decorate([
    (0, common_1.Injectable)()
], PivotTableConfigService);
exports.PivotTableConfigService = PivotTableConfigService;
