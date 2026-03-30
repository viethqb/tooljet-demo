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
const MAX_PAGE_SIZE = 2000;
const VALID_AGGREGATORS = Object.keys(AGG_SQL);

function escId(name, kind) {
    var s = String(name).replace(/[\x00-\x1f\x7f]/g, ''); // strip control chars
    switch (kind) {
        case 'mssql':
            return '[' + s.replace(/\]/g, ']]') + ']';
        case 'mysql': case 'mariadb': case 'starrocks': case 'clickhouse':
            return '`' + s.replace(/`/g, '``') + '`';
        default: // postgresql, bigquery, snowflake, redshift, oracle
            return '"' + s.replace(/"/g, '""') + '"';
    }
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
    if (buf.length < 28) throw new Error('Ciphertext too short'); // 12 nonce + 16 auth tag minimum
    var nonce = buf.subarray(0, 12);
    var authTag = buf.subarray(-16);
    var encrypted = buf.subarray(12, -16);
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
}

let PivotTableConfigService = class PivotTableConfigService {

    // ===================== AUTHORIZATION =====================

    // Verify the user's organization owns this app_version_id
    async _verifyAccess(manager, user, appVersionId) {
        if (!user || !user.organizationId) {
            throw new common_1.HttpException('Unauthorized', common_1.HttpStatus.UNAUTHORIZED);
        }
        var rows = await manager.query(
            `SELECT av.id FROM app_versions av
             JOIN apps a ON av.app_id = a.id
             WHERE av.id = $1 AND a.organization_id = $2
             LIMIT 1`,
            [appVersionId, user.organizationId]
        );
        if (rows.length === 0) {
            throw new common_1.HttpException('App version not found', common_1.HttpStatus.NOT_FOUND);
        }
    }

    // ===================== CONFIG CRUD =====================

    // Resolve component name → component UUID (from components table)
    async _resolveComponentId(manager, appVersionId, componentName) {
        var rows = await manager.query(
            `SELECT c.id FROM components c
             JOIN pages p ON c.page_id = p.id
             WHERE p.app_version_id = $1 AND c.name = $2
             LIMIT 1`,
            [appVersionId, componentName]
        );
        return rows.length > 0 ? rows[0].id : null;
    }

    async getConfig(user, appVersionId, componentName) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
            var compId = await this._resolveComponentId(manager, appVersionId, componentName);

            // Try by component_id first
            var rows = [];
            if (compId) {
                rows = await manager.query(
                    `SELECT id, config FROM pivot_table_configs WHERE app_version_id = $1 AND component_id = $2`,
                    [appVersionId, compId]
                );
            }
            // Fallback: by component_name (backward compat or pre-migration)
            if (rows.length === 0) {
                rows = await manager.query(
                    `SELECT id, config FROM pivot_table_configs WHERE app_version_id = $1 AND component_name = $2`,
                    [appVersionId, componentName]
                );
            }
            // Auto-migrate: if found a row without component_id, set it now
            if (rows.length > 0 && compId) {
                await manager.query(
                    `UPDATE pivot_table_configs SET component_id = $1, component_name = $2, updated_at = NOW()
                     WHERE id = $3 AND (component_id IS NULL OR component_id != $1)`,
                    [compId, componentName, rows[0].id]
                ).catch(function (e) { console.warn('[PivotTable] auto-migrate component_id failed:', e.message); });
            }
            return { config: rows.length > 0 ? rows[0].config : null };
        });
    }

    async getAllConfigs(user, appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
            // Join with components to return current name (even if renamed)
            var rows = await manager.query(
                `SELECT ptc.component_name, ptc.component_id, ptc.config,
                        COALESCE(c.name, ptc.component_name) AS current_name
                 FROM pivot_table_configs ptc
                 LEFT JOIN components c ON ptc.component_id = c.id
                 WHERE ptc.app_version_id = $1`,
                [appVersionId]
            );
            var configs = {};
            for (var r of rows) configs[r.current_name] = r.config;
            return { configs };
        });
    }

    async upsertConfig(user, dto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, dto.app_version_id);
            var compId = await this._resolveComponentId(manager, dto.app_version_id, dto.component_name);
            var configJson = JSON.stringify(dto.config);

            if (compId) {
                // Try UPDATE first (most common case — row already exists)
                var updated = await manager.query(
                    `UPDATE pivot_table_configs
                     SET config = $1, component_name = $2, updated_at = NOW()
                     WHERE app_version_id = $3 AND component_id = $4
                     RETURNING *`,
                    [configJson, dto.component_name, dto.app_version_id, compId]
                );

                if (updated.length > 0) {
                    // Clean up any legacy name-only row
                    await manager.query(
                        `DELETE FROM pivot_table_configs
                         WHERE app_version_id = $1 AND component_name = $2 AND (component_id IS NULL OR component_id != $3)`,
                        [dto.app_version_id, dto.component_name, compId]
                    ).catch(function (e) { console.warn('[PivotTable] legacy cleanup failed:', e.message); });
                    return { config: updated[0] };
                }

                // Row doesn't exist yet — clean up any conflicting legacy rows, then INSERT
                await manager.query(
                    `DELETE FROM pivot_table_configs
                     WHERE app_version_id = $1 AND (component_name = $2 AND component_id IS NULL)`,
                    [dto.app_version_id, dto.component_name]
                ).catch(function (e) { console.warn('[PivotTable] legacy cleanup failed:', e.message); });

                var result = await manager.query(
                    `INSERT INTO pivot_table_configs (app_version_id, component_id, component_name, config)
                     VALUES ($1, $2, $3, $4)
                     RETURNING *`,
                    [dto.app_version_id, compId, dto.component_name, configJson]
                );
                return { config: result[0] };
            } else {
                // Fallback: component not found in DB — use name-based
                // Try UPDATE first, then INSERT
                var updated = await manager.query(
                    `UPDATE pivot_table_configs
                     SET config = $1, updated_at = NOW()
                     WHERE app_version_id = $2 AND component_name = $3
                     RETURNING *`,
                    [configJson, dto.app_version_id, dto.component_name]
                );
                if (updated.length > 0) return { config: updated[0] };

                var result = await manager.query(
                    `INSERT INTO pivot_table_configs (app_version_id, component_name, config)
                     VALUES ($1, $2, $3)
                     RETURNING *`,
                    [dto.app_version_id, dto.component_name, configJson]
                );
                return { config: result[0] };
            }
        });
    }

    // ===================== DATASOURCE DETECTION =====================

    async detectDataSource(user, appVersionId, componentName) {
        // Verify authorization
        await (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
        });

        var queryInfo = await this._resolveComponentQuery(appVersionId, componentName);
        if (!queryInfo) {
            return { supported: false, kind: null, query_name: null, reason: 'No data query bound to this component' };
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

    async executePivot(user, appVersionId, componentName, pivotConfig, page, pageSize) {
        // 0. Verify authorization
        await (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
        });

        // 1. Validate pagination params
        if (pageSize !== null && pageSize !== undefined) {
            pageSize = parseInt(pageSize, 10);
            if (isNaN(pageSize) || pageSize <= 0) pageSize = null; // treat 0 and negative as "no pagination"
            else if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;
        }
        if (page !== null && page !== undefined) {
            page = parseInt(page, 10);
            if (isNaN(page) || page < 0) page = 0;
            if (page > 100000) page = 100000; // upper bound safety
        }

        // Validate aggregator
        var agg = (pivotConfig.aggregator || 'count').toLowerCase();
        if (VALID_AGGREGATORS.indexOf(agg) === -1) agg = 'count';
        pivotConfig.aggregator = agg;

        // Validate fields: must be non-empty strings, no special chars beyond alphanumeric/underscore/space/dot
        var fieldPattern = /^[\w\s.\-\u00C0-\u024F\u1E00-\u1EFF]+$/;
        var allFields = (pivotConfig.rowFields || []).concat(pivotConfig.colFields || []);
        if (pivotConfig.valueField) allFields.push(pivotConfig.valueField);
        for (var fi = 0; fi < allFields.length; fi++) {
            if (typeof allFields[fi] !== 'string' || !fieldPattern.test(allFields[fi])) {
                throw new common_1.HttpException('Invalid field name: ' + String(allFields[fi]).substring(0, 50), common_1.HttpStatus.BAD_REQUEST);
            }
        }

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

        var dbKind = (queryInfo.kind || '').toLowerCase();

        // 3. Generate pivot SQL (with optional LIMIT/OFFSET)
        var pivotSql = this._buildPivotSql(originalSql, pivotConfig, page, pageSize, dbKind);

        // 4. Execute using ToolJet's plugin system (same driver as the datasource)
        try {
            var rows = await this._executeQuery(sourceOptions, pivotSql, queryInfo.kind, queryInfo.data_source_id);

            // 5. If paginated, also get total count + grand totals
            var total = null;
            var grandTotals = null;
            if (pageSize && pageSize > 0) {
                // Count query: total number of grouped rows
                var countSql = this._buildPivotCountSql(originalSql, pivotConfig, dbKind);
                var countResult = await this._executeQuery(sourceOptions, countSql, queryInfo.kind, queryInfo.data_source_id);
                total = countResult && countResult[0] ? parseInt(countResult[0]._pivot_total || countResult[0].total || 0, 10) : 0;

                // Grand total query: aggregate across ALL data (for grand total row)
                var grandTotalSql = this._buildGrandTotalSql(originalSql, pivotConfig, dbKind);
                if (grandTotalSql) {
                    try {
                        var gtResult = await this._executeQuery(sourceOptions, grandTotalSql, queryInfo.kind, queryInfo.data_source_id);
                        grandTotals = gtResult || [];
                    } catch (gtErr) { console.warn('[PivotTable] grand total query failed:', gtErr.message); }
                }
            }

            return { data: rows, total: total, grand_totals: grandTotals, query_name: queryInfo.name };
        } catch (err) {
            // Log debug info server-side only (never expose SQL to client)
            console.error('[PivotTable] Query failed:', {
                message: err.message || String(err),
                kind: queryInfo.kind,
                sql: pivotSql.substring(0, 500),
            });
            throw new common_1.HttpException(
                'Pivot query failed. Check server logs for details.',
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
            if (typeof rawOptions === 'string') {
                try { rawOptions = JSON.parse(rawOptions); } catch (e) {
                    throw new common_1.HttpException('Malformed datasource options', common_1.HttpStatus.INTERNAL_SERVER_ERROR);
                }
            }

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
                            console.warn('[PivotTable] decryption failed for key:', key, decErr.message);
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

            // Log keys only (never log values — may contain credentials)
            console.log('[PivotTable] sourceOptions keys:', Object.keys(parsed).join(', '));

            return parsed;
        });
    }

    // ===================== INTERNAL: SQL GENERATION =====================

    _extractSql(options) {
        if (!options) return null;
        var opts = typeof options === 'string' ? JSON.parse(options) : options;
        return opts.query || opts.sql || null;
    }

    _buildPivotSql(originalSql, config, page, pageSize, kind) {
        var rowFields = config.rowFields || [];
        var colFields = config.colFields || [];
        var valueField = config.valueField || '';
        var aggregator = config.aggregator || 'count';

        var allGroupFields = rowFields.concat(colFields);
        if (allGroupFields.length === 0) {
            throw new common_1.HttpException('At least one row or column field required', common_1.HttpStatus.BAD_REQUEST);
        }

        var esc = function (f) { return escId(f, kind); };
        var alias = function (a) { return escId(a, kind); };
        var selectParts = allGroupFields.map(esc);
        var aggFunc = AGG_SQL[aggregator] || 'COUNT(*)';

        if (aggregator === 'count' || !valueField) {
            selectParts.push('COUNT(*) AS ' + alias('_pivot_value'));
        } else {
            selectParts.push(aggFunc + '(' + esc(valueField) + ') AS ' + alias('_pivot_value'));
        }
        // For weighted avg: use COUNT(valueField) to exclude NULLs, else COUNT(*)
        if (aggregator === 'avg' && valueField) {
            selectParts.push('COUNT(' + esc(valueField) + ') AS ' + alias('_pivot_count'));
        } else {
            selectParts.push('COUNT(*) AS ' + alias('_pivot_count'));
        }

        var groupBy = allGroupFields.map(esc);
        var rowGroupBy = rowFields.map(esc);
        var cleanSql = originalSql.replace(/;\s*$/, '');

        // Base grouped query (no pagination)
        var baseSql = 'SELECT ' + selectParts.join(', ') + '\n' +
            'FROM (\n' + cleanSql + '\n) AS ' + alias('_pivot_src') + '\n' +
            'GROUP BY ' + groupBy.join(', ');

        // Pagination: use DENSE_RANK on rowFields to keep all cells of one row key on same page
        if (pageSize && pageSize > 0 && rowFields.length > 0 && colFields.length > 0) {
            var rankOrder = rowGroupBy.join(', ');
            var rankedParts = selectParts.slice();
            rankedParts.push('DENSE_RANK() OVER (ORDER BY ' + rankOrder + ') AS ' + alias('_pivot_row_rank'));

            var rankedSql = 'SELECT ' + rankedParts.join(', ') + '\n' +
                'FROM (\n' + cleanSql + '\n) AS ' + alias('_pivot_src') + '\n' +
                'GROUP BY ' + groupBy.join(', ');

            var offset = (page || 0) * pageSize;
            return 'SELECT * FROM (\n' + rankedSql + '\n) AS ' + alias('_pivot_page') + '\n' +
                'WHERE ' + alias('_pivot_row_rank') + ' > ' + parseInt(offset, 10) +
                ' AND ' + alias('_pivot_row_rank') + ' <= ' + parseInt(offset + pageSize, 10) + '\n' +
                'ORDER BY ' + groupBy.join(', ');
        } else if (pageSize && pageSize > 0) {
            // No colFields: each grouped row = one visual row, simple LIMIT/OFFSET
            var offset = (page || 0) * pageSize;
            return baseSql + '\nORDER BY ' + groupBy.join(', ') +
                '\nLIMIT ' + parseInt(pageSize, 10) + ' OFFSET ' + parseInt(offset, 10);
        }

        return baseSql + '\nORDER BY ' + groupBy.join(', ');
    }

    _buildPivotCountSql(originalSql, config, kind) {
        var rowFields = config.rowFields || [];
        var esc = function (f) { return escId(f, kind); };
        if (rowFields.length === 0) return 'SELECT 0 AS ' + esc('_pivot_total');

        // Count distinct row keys (visual rows), not all GROUP BY combinations
        var groupBy = rowFields.map(esc);
        var cleanSql = originalSql.replace(/;\s*$/, '');

        return 'SELECT COUNT(*) AS ' + esc('_pivot_total') + ' FROM (\n' +
            'SELECT 1 FROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src') + '\n' +
            'GROUP BY ' + groupBy.join(', ') + '\n' +
            ') AS ' + esc('_pivot_cnt');
    }

    _buildGrandTotalSql(originalSql, config, kind) {
        var colFields = config.colFields || [];
        var valueField = config.valueField || '';
        var aggregator = config.aggregator || 'count';
        var cleanSql = originalSql.replace(/;\s*$/, '');
        var aggFunc = AGG_SQL[aggregator] || 'COUNT(*)';
        var esc = function (f) { return escId(f, kind); };

        if (colFields.length > 0) {
            // Grand total per column value + overall total
            var selectParts = colFields.map(esc);
            if (aggregator === 'count' || !valueField) {
                selectParts.push('COUNT(*) AS ' + esc('_pivot_value'));
            } else {
                selectParts.push(aggFunc + '(' + esc(valueField) + ') AS ' + esc('_pivot_value'));
            }
            // For weighted avg: use COUNT(valueField) to exclude NULLs
            if (aggregator === 'avg' && valueField) {
                selectParts.push('COUNT(' + esc(valueField) + ') AS ' + esc('_pivot_count'));
            } else {
                selectParts.push('COUNT(*) AS ' + esc('_pivot_count'));
            }
            var groupBy = colFields.map(esc);

            return 'SELECT ' + selectParts.join(', ') + '\n' +
                'FROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src') + '\n' +
                'GROUP BY ' + groupBy.join(', ') + '\n' +
                'ORDER BY ' + groupBy.join(', ');
        } else {
            // No column fields: just overall total
            var valExpr = (aggregator === 'count' || !valueField) ? 'COUNT(*)' : aggFunc + '(' + esc(valueField) + ')';
            return 'SELECT ' + valExpr + ' AS ' + esc('_pivot_value') + ' FROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src');
        }
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
