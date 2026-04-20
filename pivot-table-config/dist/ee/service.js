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
const VALID_AGGREGATORS = [
    'count', 'sum', 'avg', 'min', 'max',
    'distinct', 'median', 'percentile', 'stddev', 'variance',
    'sum-where', 'count-where', 'cum-sum', 'cum-count', 'share', 'expr',
];
// Aggregators the backend cannot compute in MySQL/MariaDB — force frontend fallback
// Note: ToolJet registers StarRocks via the MySQL plugin (kind='mysql'). StarRocks supports
// percentile_approx(), so we emit that and let real-MySQL users see a clear SQL error.
const MYSQL_UNSUPPORTED = {};
// Aggregators that produce partials the frontend CAN'T re-aggregate for totals
const NON_REAGGREGABLE = { median: 1, percentile: 1, stddev: 1, variance: 1, distinct: 1, share: 1, 'cum-sum': 1, 'cum-count': 1, expr: 1 };

// Build per-measure SQL aggregate fragment. Returns `<expr> AS <alias>`.
// measure: { field, aggregator, percentile?, where?, expression? }
// ctx: { esc, kind, colFields, rowFields, isWindow (for cumulative), cleanSql, alias }
function buildAggSql(measure, alias, ctx) {
    var esc = ctx.esc;
    var kind = ctx.kind;
    var agg = measure.aggregator || 'count';
    var field = measure.field;
    var escField = field ? esc(field) : null;

    // Safely emit a scalar value for sum-where / count-where WHERE fragment
    function emitWhere(where) {
        if (!where || !where.field) return '1=1';
        var col = esc(where.field);
        var op = where.op || '=';
        var val = where.value;
        // Validate op
        var allowed = { '=': 1, '!=': 1, '>': 1, '<': 1, '>=': 1, '<=': 1, 'like': 1, 'is null': 1, 'is not null': 1 };
        if (!allowed[op]) op = '=';
        if (op === 'is null') return col + ' IS NULL';
        if (op === 'is not null') return col + ' IS NOT NULL';
        // Quote value as string literal (safe: replace single quotes)
        var vStr = "'" + String(val == null ? '' : val).replace(/'/g, "''") + "'";
        // Numeric comparison: if looks numeric, also try as number (DB coerces)
        if (op === 'like') return col + ' LIKE ' + vStr;
        return col + ' ' + op + ' ' + vStr;
    }

    function countDistinct() {
        if (kind === 'clickhouse') return 'uniqExact(' + escField + ')';
        return 'COUNT(DISTINCT ' + escField + ')';
    }
    function medianSql() {
        if (kind === 'clickhouse') return 'quantileExact(0.5)(' + escField + ')';
        if (kind === 'bigquery') return 'APPROX_QUANTILES(' + escField + ', 100)[OFFSET(50)]';
        if (kind === 'snowflake') return 'MEDIAN(' + escField + ')';
        // StarRocks uses MySQL plugin (kind='mysql') and supports percentile_approx natively
        if (kind === 'starrocks' || kind === 'mysql' || kind === 'mariadb') return 'percentile_approx(' + escField + ', 0.5)';
        // postgresql / mssql / oracle / redshift
        return 'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ' + escField + ')';
    }
    function percentileSql() {
        var p = parseFloat(measure.percentile);
        if (isNaN(p) || p < 0 || p > 1) p = 0.95;
        p = Math.round(p * 10000) / 10000;
        if (kind === 'clickhouse') return 'quantile(' + p + ')(' + escField + ')';
        if (kind === 'bigquery') {
            var offset = Math.round(p * 100);
            return 'APPROX_QUANTILES(' + escField + ', 100)[OFFSET(' + offset + ')]';
        }
        if (kind === 'starrocks' || kind === 'mysql' || kind === 'mariadb') return 'percentile_approx(' + escField + ', ' + p + ')';
        return 'PERCENTILE_CONT(' + p + ') WITHIN GROUP (ORDER BY ' + escField + ')';
    }
    function stddevSql() {
        if (kind === 'mssql') return 'STDEV(' + escField + ')';
        if (kind === 'clickhouse') return 'stddevSamp(' + escField + ')';
        return 'STDDEV_SAMP(' + escField + ')';
    }
    function varianceSql() {
        if (kind === 'mssql') return 'VAR(' + escField + ')';
        if (kind === 'oracle') return 'VARIANCE(' + escField + ')';
        if (kind === 'clickhouse') return 'varSamp(' + escField + ')';
        return 'VAR_SAMP(' + escField + ')';
    }
    function exprSql() {
        // Always re-parse server-side; do not trust client-provided AST.
        if (!measure.expression) return '0';
        try {
            var ast = parseExpressionSrv(measure.expression);
            return compileAstToSql(ast, esc);
        } catch (e) {
            throw new common_1.HttpException('Invalid expression: ' + e.message, common_1.HttpStatus.BAD_REQUEST);
        }
    }

    var expr;
    switch (agg) {
        case 'count': expr = 'COUNT(*)'; break;
        case 'sum': expr = 'SUM(' + escField + ')'; break;
        case 'avg': expr = 'AVG(' + escField + ')'; break;
        case 'min': expr = 'MIN(' + escField + ')'; break;
        case 'max': expr = 'MAX(' + escField + ')'; break;
        case 'distinct': expr = countDistinct(); break;
        case 'median': expr = medianSql(); break;
        case 'percentile': expr = percentileSql(); break;
        case 'stddev': expr = stddevSql(); break;
        case 'variance': expr = varianceSql(); break;
        case 'sum-where': expr = 'SUM(CASE WHEN ' + emitWhere(measure.where) + ' THEN ' + (escField || '0') + ' ELSE 0 END)'; break;
        case 'count-where': expr = 'SUM(CASE WHEN ' + emitWhere(measure.where) + ' THEN 1 ELSE 0 END)'; break;
        case 'share': expr = 'SUM(' + (escField || '1') + ')'; break; // denominator handled via separate query
        case 'cum-sum': expr = 'SUM(' + (escField || '1') + ')'; break; // window applied by caller
        case 'cum-count': expr = 'COUNT(*)'; break;
        case 'expr': expr = exprSql(); break;
        default: expr = 'COUNT(*)';
    }
    return expr + ' AS ' + esc(alias);
}

// Server-side expression parser (mirror of frontend, so we never trust client AST).
// Grammar: Expr := Term (('+'|'-') Term)*; Term := Factor (('*'|'/') Factor)*;
// Factor := Number | AggCall | '(' Expr ')' | '-' Factor; AggCall := FN '(' Ident ')'
var AGG_CALL_NAMES_SRV = { SUM: 1, AVG: 1, COUNT: 1, MIN: 1, MAX: 1, COUNT_DISTINCT: 1 };
function parseExpressionSrv(src) {
    src = String(src || '');
    var toks = [], i = 0, n = src.length;
    while (i < n) {
        var c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
        if ((c >= '0' && c <= '9') || c === '.') {
            var j = i;
            while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
            toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
            i = j; continue;
        }
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
            var k = i;
            while (k < n && ((src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= 'a' && src[k] <= 'z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '_' || src[k] === ' ' || src[k] === '.')) k++;
            toks.push({ t: 'ident', v: src.slice(i, k).trim() });
            i = k; continue;
        }
        throw new Error('Unexpected character in expression: ' + c);
    }
    var p = 0;
    function peek() { return toks[p]; }
    function eat(t) { var tok = toks[p]; if (!tok || tok.t !== t) throw new Error('Expected ' + t); p++; return tok; }
    function E() { var l = T(); while (peek() && (peek().t === '+' || peek().t === '-')) { var op = toks[p++].t; l = { type: 'bin', op: op, l: l, r: T() }; } return l; }
    function T() { var l = F(); while (peek() && (peek().t === '*' || peek().t === '/')) { var op = toks[p++].t; l = { type: 'bin', op: op, l: l, r: F() }; } return l; }
    function F() {
        var tok = peek();
        if (!tok) throw new Error('Unexpected end of expression');
        if (tok.t === 'num') { p++; return { type: 'num', v: tok.v }; }
        if (tok.t === '-') { p++; return { type: 'neg', e: F() }; }
        if (tok.t === '(') { p++; var e = E(); eat(')'); return e; }
        if (tok.t === 'ident') {
            p++;
            var name = tok.v.trim();
            if (peek() && peek().t === '(') {
                var up = name.toUpperCase();
                if (!AGG_CALL_NAMES_SRV[up]) throw new Error('Unknown aggregate: ' + name);
                p++;
                var col = eat('ident').v.trim();
                eat(')');
                return { type: 'agg', fn: up, col: col };
            }
            throw new Error('Bare identifier: ' + name);
        }
        throw new Error('Unexpected token');
    }
    var ast = E();
    if (p < toks.length) throw new Error('Trailing tokens in expression');
    return ast;
}

// Compile parsed AST (from frontend parser) to SQL.
// Expects AST with the same shape as frontend parseExpr output.
function compileAstToSql(ast, esc) {
    function walk(n) {
        if (!n) return '0';
        switch (n.type) {
            case 'num': return String(n.v);
            case 'neg': return '(-' + walk(n.e) + ')';
            case 'bin': return '(' + walk(n.l) + ' ' + n.op + ' ' + walk(n.r) + ')';
            case 'agg':
                var col = esc(n.col);
                if (n.fn === 'SUM') return 'SUM(' + col + ')';
                if (n.fn === 'AVG') return 'AVG(' + col + ')';
                if (n.fn === 'COUNT') return 'COUNT(*)';
                if (n.fn === 'COUNT_DISTINCT') return 'COUNT(DISTINCT ' + col + ')';
                if (n.fn === 'MIN') return 'MIN(' + col + ')';
                if (n.fn === 'MAX') return 'MAX(' + col + ')';
                return '0';
        }
        return '0';
    }
    return walk(ast);
}

// Expose normalize helper on server side too
function normalizeServerConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    if (!Array.isArray(cfg.measures) || cfg.measures.length === 0) {
        cfg.measures = [{
            id: 'm0',
            field: cfg.valueField || '',
            aggregator: cfg.aggregator || 'count',
        }];
    }
    for (var i = 0; i < cfg.measures.length; i++) {
        var m = cfg.measures[i];
        if (!m.aggregator) m.aggregator = 'count';
        if (m.field === undefined) m.field = '';
        if (VALID_AGGREGATORS.indexOf(m.aggregator) === -1) m.aggregator = 'count';
    }
    cfg.valueField = cfg.measures[0].field;
    cfg.aggregator = cfg.measures[0].aggregator;
    return cfg;
}

// Decide if backend can handle this config; returns { backendOk, reason }.
// For mysql/mariadb + quantile aggs, we return backendOk=false (force FE fallback).
function canBackendHandle(measures, kind) {
    var isMyType = (kind === 'mysql' || kind === 'mariadb');
    for (var i = 0; i < measures.length; i++) {
        var m = measures[i];
        if (isMyType && MYSQL_UNSUPPORTED[m.aggregator]) {
            return { backendOk: false, reason: 'Aggregator ' + m.aggregator + ' not supported on ' + kind };
        }
    }
    return { backendOk: true, reason: null };
}

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

    // ===================== TABLE PROPERTY OVERRIDES =====================

    // When pivot is enabled, set Table component properties to hide UI elements
    // When disabled, restore original values
    static PIVOT_OVERRIDES = {
      displaySearchBox: '{{false}}',
      enabledSort: '{{false}}',
      showFilterButton: '{{false}}',
      enablePagination: '{{false}}',
      allowSelection: '{{false}}',
      showAddNewRowButton: '{{false}}',
      showDownloadButton: '{{false}}',
      showBulkUpdateActions: '{{false}}',
      highlightSelectedRow: '{{false}}',
      showBulkSelector: '{{false}}',
    };

    async _applyTableOverrides(manager, componentId, pivotEnabled, previousConfig) {
        if (!componentId) return;
        try {
            if (pivotEnabled) {
                // Save original values before overriding
                var origRow = await manager.query(
                    `SELECT properties FROM components WHERE id = $1`, [componentId]
                );
                if (origRow.length === 0) return;
                var props = origRow[0].properties;
                if (typeof props === 'string') props = JSON.parse(props);

                // Build backup of original values
                var backup = {};
                var overrideJson = {};
                var keys = Object.keys(PivotTableConfigService.PIVOT_OVERRIDES);
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    if (props[k]) backup[k] = props[k].value;
                    overrideJson[k] = { value: PivotTableConfigService.PIVOT_OVERRIDES[k] };
                }

                // Apply overrides via jsonb merge
                await manager.query(
                    `UPDATE components SET properties = (properties::jsonb || $1::jsonb)::json WHERE id = $2`,
                    [JSON.stringify(overrideJson), componentId]
                );
                console.log('[PivotTable] Applied table overrides for', componentId);
                return backup;
            } else if (previousConfig && previousConfig._originalTableProps) {
                // Restore original values
                var restoreJson = {};
                var origProps = previousConfig._originalTableProps;
                var rKeys = Object.keys(origProps);
                for (var ri = 0; ri < rKeys.length; ri++) {
                    restoreJson[rKeys[ri]] = { value: origProps[rKeys[ri]] };
                }
                if (rKeys.length > 0) {
                    await manager.query(
                        `UPDATE components SET properties = (properties::jsonb || $1::jsonb)::json WHERE id = $2`,
                        [JSON.stringify(restoreJson), componentId]
                    );
                    console.log('[PivotTable] Restored table properties for', componentId);
                }
            }
        } catch (e) { console.warn('[PivotTable] table override failed:', e.message); }
    }

    // ===================== CONFIG CRUD =====================

    // Resolve component name → component UUID (from components table)
    // If clientComponentId is provided, verify it exists and use it directly (multi-page safe)
    async _resolveComponentId(manager, appVersionId, componentName, clientComponentId) {
        if (clientComponentId) {
            var check = await manager.query(
                `SELECT c.id FROM components c
                 JOIN pages p ON c.page_id = p.id
                 WHERE c.id = $1 AND p.app_version_id = $2
                 LIMIT 1`,
                [clientComponentId, appVersionId]
            );
            if (check.length > 0) return check[0].id;
        }
        // Fallback: resolve by name (may be ambiguous if same name on multiple pages)
        var rows = await manager.query(
            `SELECT c.id FROM components c
             JOIN pages p ON c.page_id = p.id
             WHERE p.app_version_id = $1 AND c.name = $2
             LIMIT 1`,
            [appVersionId, componentName]
        );
        return rows.length > 0 ? rows[0].id : null;
    }

    async getConfig(user, appVersionId, componentName, clientComponentId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
            var compId = await this._resolveComponentId(manager, appVersionId, componentName, clientComponentId);

            var rows = [];
            if (compId) {
                // Exact match by component_id (safe — identifies the right component)
                rows = await manager.query(
                    `SELECT id, config FROM pivot_table_configs WHERE app_version_id = $1 AND component_id = $2`,
                    [appVersionId, compId]
                );
            }
            if (rows.length === 0 && !compId) {
                // Fallback by name ONLY when component can't be resolved (pre-migration data)
                rows = await manager.query(
                    `SELECT id, config FROM pivot_table_configs WHERE app_version_id = $1 AND component_name = $2 AND component_id IS NULL`,
                    [appVersionId, componentName]
                );
                // Auto-migrate: attach component_id to legacy row
                if (rows.length > 0 && compId) {
                    await manager.query(
                        `UPDATE pivot_table_configs SET component_id = $1, updated_at = NOW() WHERE id = $2`,
                        [compId, rows[0].id]
                    ).catch(function (e) { console.warn('[PivotTable] auto-migrate failed:', e.message); });
                }
            }
            return { config: rows.length > 0 ? rows[0].config : null };
        });
    }

    async getAllConfigs(user, appVersionId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
            var rows = await manager.query(
                `SELECT ptc.component_name, ptc.component_id, ptc.config,
                        COALESCE(c.name, ptc.component_name) AS current_name
                 FROM pivot_table_configs ptc
                 LEFT JOIN components c ON ptc.component_id = c.id
                 WHERE ptc.app_version_id = $1`,
                [appVersionId]
            );
            // Key by component_id (unique) with name for display, fallback to name-only for legacy rows
            var configs = {};
            for (var r of rows) {
                var key = r.component_id || r.current_name;
                configs[key] = { config: r.config, name: r.current_name, component_id: r.component_id };
            }
            return { configs };
        });
    }

    async upsertConfig(user, dto) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, dto.app_version_id);
            var compId = await this._resolveComponentId(manager, dto.app_version_id, dto.component_name, dto.component_id);

            // Apply/remove table property overrides when pivot enabled/disabled
            var pivotEnabled = dto.config && dto.config.enabled;
            var backup = await this._applyTableOverrides(manager, compId, pivotEnabled, dto.config);
            // Store original props backup in config so we can restore later
            if (backup && pivotEnabled) {
                dto.config._originalTableProps = backup;
            }
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

    async detectDataSource(user, appVersionId, componentName, clientComponentId) {
        // Verify authorization
        await (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            await this._verifyAccess(manager, user, appVersionId);
        });

        var queryInfo = await this._resolveComponentQuery(appVersionId, componentName, clientComponentId);
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

    async executePivot(user, appVersionId, componentName, pivotConfig, page, pageSize, clientComponentId) {
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

        // Normalize (ensures measures[] exists)
        normalizeServerConfig(pivotConfig);

        // Validate every measure's aggregator
        for (var vi = 0; vi < pivotConfig.measures.length; vi++) {
            var vag = (pivotConfig.measures[vi].aggregator || 'count').toLowerCase();
            if (VALID_AGGREGATORS.indexOf(vag) === -1) vag = 'count';
            pivotConfig.measures[vi].aggregator = vag;
        }
        pivotConfig.aggregator = pivotConfig.measures[0].aggregator;

        // Validate fields: must be non-empty strings, no special chars beyond alphanumeric/underscore/space/dot
        var fieldPattern = /^[\w\s.\-\u00C0-\u024F\u1E00-\u1EFF]+$/;
        var allFields = (pivotConfig.rowFields || []).concat(pivotConfig.colFields || []);
        for (var mf = 0; mf < pivotConfig.measures.length; mf++) {
            var mMm = pivotConfig.measures[mf];
            if (mMm.field) allFields.push(mMm.field);
            if (mMm.where && mMm.where.field) allFields.push(mMm.where.field);
        }
        for (var fi = 0; fi < allFields.length; fi++) {
            if (typeof allFields[fi] !== 'string' || !fieldPattern.test(allFields[fi])) {
                throw new common_1.HttpException('Invalid field name: ' + String(allFields[fi]).substring(0, 50), common_1.HttpStatus.BAD_REQUEST);
            }
        }

        // 1. Resolve the data query bound to this component
        var queryInfo = await this._resolveComponentQuery(appVersionId, componentName, clientComponentId);
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

        // MySQL/MariaDB: reject quantile aggs → client falls back to frontend pivot
        var capability = canBackendHandle(pivotConfig.measures, dbKind);
        if (!capability.backendOk) {
            throw new common_1.HttpException(
                'Backend pivot unavailable: ' + capability.reason + '. Use frontend pivot.',
                common_1.HttpStatus.BAD_REQUEST
            );
        }

        // 3. Generate pivot SQL (with optional LIMIT/OFFSET)
        var pivotSql = this._buildPivotSql(originalSql, pivotConfig, page, pageSize, dbKind);

        // 4. Execute using ToolJet's plugin system (same driver as the datasource)
        try {
            var rows = await this._executeQuery(sourceOptions, pivotSql, queryInfo.kind, queryInfo.data_source_id);

            // 5. Count (when paginated) + grand totals (always — needed for correct non-reaggregable aggregators)
            var total = null;
            var grandTotals = null;
            if (pageSize && pageSize > 0) {
                var countSql = this._buildPivotCountSql(originalSql, pivotConfig, dbKind);
                var countResult = await this._executeQuery(sourceOptions, countSql, queryInfo.kind, queryInfo.data_source_id);
                total = countResult && countResult[0] ? parseInt(countResult[0]._pivot_total || countResult[0].total || 0, 10) : 0;
            }
            // Grand totals + subtotals — server-side (correct for non-reaggregable aggregators)
            // (a) Per-column grand total: GROUP BY colFields
            // (b) Overall grand total: no GROUP BY
            // (c) Subtotal per row-field level: GROUP BY rowFields[0..n] + colFields  (for multi-level subtotal rows)
            var subtotals = null;
            try {
                var grandTotalSql = this._buildGrandTotalSql(originalSql, pivotConfig, dbKind);
                if (grandTotalSql) {
                    var gtResult = await this._executeQuery(sourceOptions, grandTotalSql, queryInfo.kind, queryInfo.data_source_id);
                    grandTotals = gtResult || [];
                }
                if ((pivotConfig.colFields || []).length > 0) {
                    var overallConfig = Object.assign({}, pivotConfig, { colFields: [] });
                    var overallSql = this._buildGrandTotalSql(originalSql, overallConfig, dbKind);
                    if (overallSql) {
                        var overallResult = await this._executeQuery(sourceOptions, overallSql, queryInfo.kind, queryInfo.data_source_id);
                        if (overallResult && overallResult[0]) {
                            overallResult[0]._pivot_overall = true;
                            grandTotals = (grandTotals || []).concat(overallResult);
                        }
                    }
                }
                // Subtotals: one query per level (prefix of rowFields, keeping colFields intact)
                // Plus: leaf-level per-row total (GROUP BY all rowFields, NO colFields) for Row Total cells on data rows
                var rowFields = pivotConfig.rowFields || [];
                var colFields = pivotConfig.colFields || [];
                if (rowFields.length > 0) {
                    subtotals = [];
                    // Subtotal rows: level 0..rowFields.length-2 (all prefixes except full)
                    for (var lvl = 0; lvl < rowFields.length - 1; lvl++) {
                        var prefixRow = rowFields.slice(0, lvl + 1);
                        var subtotalCfg = Object.assign({}, pivotConfig, { rowFields: prefixRow });
                        var subtotalSql = this._buildSubtotalSql(originalSql, subtotalCfg, dbKind, prefixRow, colFields);
                        if (subtotalSql) {
                            var subResult = await this._executeQuery(sourceOptions, subtotalSql, queryInfo.kind, queryInfo.data_source_id);
                            if (subResult && subResult.length) {
                                for (var sr = 0; sr < subResult.length; sr++) {
                                    subResult[sr]._pivot_subtotal_level = lvl;
                                }
                                subtotals = subtotals.concat(subResult);
                            }
                        }
                        if (colFields.length > 0) {
                            var subtotalOverallCfg = Object.assign({}, pivotConfig, { rowFields: prefixRow, colFields: [] });
                            var subtotalOverallSql = this._buildSubtotalSql(originalSql, subtotalOverallCfg, dbKind, prefixRow, []);
                            if (subtotalOverallSql) {
                                var subOverallRes = await this._executeQuery(sourceOptions, subtotalOverallSql, queryInfo.kind, queryInfo.data_source_id);
                                if (subOverallRes && subOverallRes.length) {
                                    for (var sor = 0; sor < subOverallRes.length; sor++) {
                                        subOverallRes[sor]._pivot_subtotal_level = lvl;
                                        subOverallRes[sor]._pivot_overall = true;
                                    }
                                    subtotals = subtotals.concat(subOverallRes);
                                }
                            }
                        }
                    }
                    // Leaf-level per-row total: GROUP BY all rowFields, NO colFields
                    // Used for "Row Total" cell on each DATA row (correct for non-reaggregable aggs)
                    if (colFields.length > 0) {
                        var leafLevel = rowFields.length - 1;
                        var leafOverallCfg = Object.assign({}, pivotConfig, { colFields: [] });
                        var leafOverallSql = this._buildSubtotalSql(originalSql, leafOverallCfg, dbKind, rowFields, []);
                        if (leafOverallSql) {
                            var leafRes = await this._executeQuery(sourceOptions, leafOverallSql, queryInfo.kind, queryInfo.data_source_id);
                            if (leafRes && leafRes.length) {
                                for (var lr = 0; lr < leafRes.length; lr++) {
                                    leafRes[lr]._pivot_subtotal_level = leafLevel;
                                    leafRes[lr]._pivot_overall = true;
                                }
                                subtotals = subtotals.concat(leafRes);
                            }
                        }
                    }
                }
            } catch (gtErr) { console.warn('[PivotTable] grand total/subtotal query failed:', gtErr.message); }

            return { data: rows, total: total, grand_totals: grandTotals, subtotals: subtotals, query_name: queryInfo.name };
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

    async _resolveComponentQuery(appVersionId, componentName, clientComponentId) {
        return (0, database_helper_1.dbTransactionWrap)(async (manager) => {
            // components table has: name, type, properties (JSON with data binding)
            // joined via: components.page_id → pages.id, pages.app_version_id = $1
            var compRows;
            if (clientComponentId) {
                // Exact match by component UUID (multi-page safe)
                compRows = await manager.query(
                    `SELECT c.name, c.type, c.properties
                     FROM components c
                     JOIN pages p ON c.page_id = p.id
                     WHERE c.id = $1 AND p.app_version_id = $2`,
                    [clientComponentId, appVersionId]
                );
            }
            if (!compRows || compRows.length === 0) {
                // Fallback: by name (may match multiple across pages)
                compRows = await manager.query(
                    `SELECT c.name, c.type, c.properties
                     FROM components c
                     JOIN pages p ON c.page_id = p.id
                     WHERE p.app_version_id = $1 AND c.name = $2`,
                    [appVersionId, componentName]
                );
            }

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
        normalizeServerConfig(config);
        var rowFields = config.rowFields || [];
        var colFields = config.colFields || [];
        var measures = config.measures;

        var allGroupFields = rowFields.concat(colFields);
        if (allGroupFields.length === 0) {
            throw new common_1.HttpException('At least one row or column field required', common_1.HttpStatus.BAD_REQUEST);
        }

        var esc = function (f) { return escId(f, kind); };
        var alias = function (a) { return escId(a, kind); };
        var selectParts = allGroupFields.map(esc);

        // Emit one aggregated column per measure (multi-measure support)
        for (var mi = 0; mi < measures.length; mi++) {
            var m = measures[mi];
            var aliasName = '_pivot_m_' + mi;
            selectParts.push(buildAggSql(m, aliasName, { esc: esc, kind: kind, colFields: colFields, rowFields: rowFields }));
            // Weighted avg companion count
            if (m.aggregator === 'avg' && m.field) {
                selectParts.push('COUNT(' + esc(m.field) + ') AS ' + alias('_pivot_mc_' + mi));
            } else {
                selectParts.push('COUNT(*) AS ' + alias('_pivot_mc_' + mi));
            }
        }
        // Legacy alias for backward-compat: first measure mirrored to _pivot_value / _pivot_count
        var m0 = measures[0];
        var firstExpr;
        switch (m0.aggregator) {
            case 'count': firstExpr = 'COUNT(*)'; break;
            case 'sum': firstExpr = 'SUM(' + esc(m0.field) + ')'; break;
            case 'avg': firstExpr = 'AVG(' + esc(m0.field) + ')'; break;
            case 'min': firstExpr = 'MIN(' + esc(m0.field) + ')'; break;
            case 'max': firstExpr = 'MAX(' + esc(m0.field) + ')'; break;
            default: firstExpr = 'COUNT(*)';
        }
        selectParts.push(firstExpr + ' AS ' + alias('_pivot_value'));
        if (m0.aggregator === 'avg' && m0.field) {
            selectParts.push('COUNT(' + esc(m0.field) + ') AS ' + alias('_pivot_count'));
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

        // Check if any measure is cumulative — wrap in window function
        var hasCumulative = measures.some(function (m) { return m.aggregator === 'cum-sum' || m.aggregator === 'cum-count'; });
        if (hasCumulative) {
            // Build outer SELECT with windows over the base query
            var outerParts = allGroupFields.map(esc);
            for (var ci = 0; ci < measures.length; ci++) {
                var mc = measures[ci];
                var baseAlias = alias('_pivot_m_' + ci);
                if (mc.aggregator === 'cum-sum' || mc.aggregator === 'cum-count') {
                    var partition = colFields.length ? ('PARTITION BY ' + colFields.map(esc).join(', ') + ' ') : '';
                    var orderBy = 'ORDER BY ' + rowGroupBy.join(', ');
                    outerParts.push('SUM(' + baseAlias + ') OVER (' + partition + orderBy + ' ROWS UNBOUNDED PRECEDING) AS ' + baseAlias);
                } else {
                    outerParts.push(baseAlias);
                }
                outerParts.push(alias('_pivot_mc_' + ci));
            }
            outerParts.push(alias('_pivot_value'));
            outerParts.push(alias('_pivot_count'));
            baseSql = 'SELECT ' + outerParts.join(', ') + ' FROM (\n' + baseSql + '\n) AS ' + alias('_pivot_cum');
        }

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

    // Subtotal SQL: GROUP BY prefixRowFields + colFields. Emits same measure columns as main pivot.
    _buildSubtotalSql(originalSql, config, kind, prefixRowFields, colFields) {
        normalizeServerConfig(config);
        var measures = config.measures;
        var cleanSql = originalSql.replace(/;\s*$/, '');
        var esc = function (f) { return escId(f, kind); };
        var m0 = measures[0];

        var allGroup = (prefixRowFields || []).concat(colFields || []);
        var selectParts = allGroup.map(esc);
        for (var mi = 0; mi < measures.length; mi++) {
            var m = measures[mi];
            selectParts.push(buildAggSql(m, '_pivot_m_' + mi, { esc: esc, kind: kind, colFields: colFields, rowFields: prefixRowFields }));
            if (m.aggregator === 'avg' && m.field) {
                selectParts.push('COUNT(' + esc(m.field) + ') AS ' + esc('_pivot_mc_' + mi));
            } else {
                selectParts.push('COUNT(*) AS ' + esc('_pivot_mc_' + mi));
            }
        }
        var firstExpr;
        switch (m0.aggregator) {
            case 'count': firstExpr = 'COUNT(*)'; break;
            case 'sum': firstExpr = 'SUM(' + esc(m0.field) + ')'; break;
            case 'avg': firstExpr = 'AVG(' + esc(m0.field) + ')'; break;
            case 'min': firstExpr = 'MIN(' + esc(m0.field) + ')'; break;
            case 'max': firstExpr = 'MAX(' + esc(m0.field) + ')'; break;
            default: firstExpr = 'COUNT(*)';
        }
        selectParts.push(firstExpr + ' AS ' + esc('_pivot_value'));
        if (m0.aggregator === 'avg' && m0.field) {
            selectParts.push('COUNT(' + esc(m0.field) + ') AS ' + esc('_pivot_count'));
        } else {
            selectParts.push('COUNT(*) AS ' + esc('_pivot_count'));
        }
        if (allGroup.length === 0) {
            return 'SELECT ' + selectParts.join(', ') + '\nFROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src');
        }
        var groupBy = allGroup.map(esc);
        return 'SELECT ' + selectParts.join(', ') + '\n' +
            'FROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src') + '\n' +
            'GROUP BY ' + groupBy.join(', ') + '\n' +
            'ORDER BY ' + groupBy.join(', ');
    }

    _buildGrandTotalSql(originalSql, config, kind) {
        normalizeServerConfig(config);
        var colFields = config.colFields || [];
        var measures = config.measures;
        var cleanSql = originalSql.replace(/;\s*$/, '');
        var esc = function (f) { return escId(f, kind); };
        var m0 = measures[0];

        // Build multi-measure SELECT fragment (for the first measure it also mirrors to _pivot_value for back-compat)
        function buildMeasureParts() {
            var parts = [];
            for (var mi = 0; mi < measures.length; mi++) {
                var m = measures[mi];
                parts.push(buildAggSql(m, '_pivot_m_' + mi, { esc: esc, kind: kind, colFields: colFields, rowFields: [] }));
                if (m.aggregator === 'avg' && m.field) {
                    parts.push('COUNT(' + esc(m.field) + ') AS ' + esc('_pivot_mc_' + mi));
                } else {
                    parts.push('COUNT(*) AS ' + esc('_pivot_mc_' + mi));
                }
            }
            // Legacy mirror
            var firstExpr;
            switch (m0.aggregator) {
                case 'count': firstExpr = 'COUNT(*)'; break;
                case 'sum': firstExpr = 'SUM(' + esc(m0.field) + ')'; break;
                case 'avg': firstExpr = 'AVG(' + esc(m0.field) + ')'; break;
                case 'min': firstExpr = 'MIN(' + esc(m0.field) + ')'; break;
                case 'max': firstExpr = 'MAX(' + esc(m0.field) + ')'; break;
                default: firstExpr = 'COUNT(*)';
            }
            parts.push(firstExpr + ' AS ' + esc('_pivot_value'));
            if (m0.aggregator === 'avg' && m0.field) {
                parts.push('COUNT(' + esc(m0.field) + ') AS ' + esc('_pivot_count'));
            } else {
                parts.push('COUNT(*) AS ' + esc('_pivot_count'));
            }
            return parts;
        }

        if (colFields.length > 0) {
            var selectParts = colFields.map(esc).concat(buildMeasureParts());
            var groupBy = colFields.map(esc);
            return 'SELECT ' + selectParts.join(', ') + '\n' +
                'FROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src') + '\n' +
                'GROUP BY ' + groupBy.join(', ') + '\n' +
                'ORDER BY ' + groupBy.join(', ');
        } else {
            return 'SELECT ' + buildMeasureParts().join(', ') + '\nFROM (\n' + cleanSql + '\n) AS ' + esc('_pivot_src');
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
