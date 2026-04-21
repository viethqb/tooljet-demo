#!/usr/bin/env python3
"""Comprehensive backend E2E tests for the pivot table.

Instead of driving a browser, this suite:
  1. Builds a fresh app with a SQL query against the StarRocks demo datasource
  2. Seeds different pivot configs
  3. POSTs to /api/pivot-table-config/execute to get server-computed pivot rows
  4. Asserts on exact aggregate values

This catches real bugs in:
  - SQL generation (buildAggSql, GROUP BY, dialect escaping)
  - Backend pagination (DENSE_RANK, LIMIT/OFFSET)
  - Backend ORDER BY (row:N, rowTotal:mi)
  - Grand Total + subtotal per level
  - All aggregators in a real DB environment (StarRocks/MySQL dialect)

Prerequisites: StarRocks container up with demo.sales_rich seeded (55 rows, 3 regions).

Expected baseline aggregates (from actual data):
  APAC: sum=92950, count=21
  EU:   sum=98000, count=19
  NA:   sum=87000, count=15
  ALL:  sum=277950, count=55
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tj_client import TJClient


APP_NAME = "e2e-pivot-backend"
QUERY_NAME = "salesRich"
COMPONENT_NAME = "pivot1"
STARROCKS_DS_NAME = "starrocks"

# Baseline (computed once from the SQL the test actually runs)
EXPECTED = {
    "APAC": {"sum": 92950.0, "count": 21},
    "EU":   {"sum": 98000.0, "count": 19},
    "NA":   {"sum": 87000.0, "count": 15},
    "TOTAL": {"sum": 277950.0, "count": 55},
}


# ---- Pretty assertions ----

_passed = 0
_failed = []

def _eq(name, actual, expected, delta=0.01):
    """Soft equality check with float tolerance + numeric-string coercion.
    (StarRocks returns DECIMAL as strings over JSON.)"""
    global _passed
    ok = False
    # Coerce numeric strings to float for comparison when expected is numeric
    if isinstance(expected, (int, float)) and isinstance(actual, str):
        try:
            actual = float(actual)
        except ValueError:
            pass
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        ok = abs(float(actual) - float(expected)) < delta
    else:
        ok = actual == expected
    if ok:
        _passed += 1
        print(f"  ✔ {name}: {actual}")
    else:
        _failed.append((name, actual, expected))
        print(f"  ✖ {name}: got {actual!r}, expected {expected!r}")

def _assert_row(rows, match, expectations):
    """Find row where each key in `match` equals its expected value, then
    assert each key in `expectations` equals its value."""
    for r in rows:
        if all(str(r.get(k)) == str(v) for k, v in match.items()):
            for k, v in expectations.items():
                _eq(f"row {match} → {k}", r.get(k), v)
            return r
    _failed.append((f"row {match}", "not found", expectations))
    print(f"  ✖ row {match} not found in {len(rows)} rows")
    return None


# ---- Setup helpers ----

def setup_app(c: TJClient):
    """Create or recreate test app and return ids."""
    old = c.find_app_by_name(APP_NAME)
    if old:
        c.delete_app(old["id"])
    app = c.create_app(APP_NAME)
    v = c.get_app_version(app["id"])

    # Find StarRocks datasource
    ds_id = get_datasource_id(v["id"])

    # Create SQL query
    query_sql = "SELECT region, country, product_category, product, revenue, quantity, cost, is_paid FROM demo.sales_rich"
    create_sql_query(c, app["id"], v["id"], ds_id, QUERY_NAME, query_sql)

    # Create Table component
    comp_id = str(uuid.uuid4())
    body = {
        "is_user_switched_version": False,
        "pageId": v["home_page_id"],
        "diff": {comp_id: {
            "name": COMPONENT_NAME, "type": "Table",
            "properties": {"data": {"value": "{{queries." + QUERY_NAME + ".data}}"}, "columns": {"value": []}},
            "styles": {}, "validation": {}, "others": {},
            "layouts": {"desktop": {"top": 60, "left": 0, "width": 43, "height": 400},
                        "mobile":  {"top": 60, "left": 0, "width": 43, "height": 400}},
        }}
    }
    r = c.session.post(f"{c.base_url}/api/v2/apps/{app['id']}/versions/{v['id']}/components",
                       json=body, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Create component failed: {r.text[:200]}")
    return app["id"], v["id"], comp_id


def get_component_id(app_version_id: str) -> str:
    """Look up the test component's ID from DB."""
    sql = (
        f"SELECT c.id FROM components c JOIN pages p ON c.page_id=p.id "
        f"WHERE p.app_version_id='{app_version_id}' AND c.name='{COMPONENT_NAME}' LIMIT 1"
    )
    out = subprocess.check_output(
        ["docker", "exec", "dp-pg-tooljet", "psql", "-U", "postgres",
         "-d", "tooljet_production", "-At", "-c", sql], text=True).strip()
    if not out:
        raise RuntimeError(f"Component '{COMPONENT_NAME}' not found")
    return out


def get_datasource_id(app_version_id: str) -> str:
    """Look up StarRocks datasource ID via DB."""
    sql = f"SELECT id FROM data_sources WHERE name='{STARROCKS_DS_NAME}' LIMIT 1"
    out = subprocess.check_output(
        ["docker", "exec", "dp-pg-tooljet", "psql", "-U", "postgres",
         "-d", "tooljet_production", "-At", "-c", sql], text=True).strip()
    if not out:
        raise RuntimeError(f"StarRocks datasource '{STARROCKS_DS_NAME}' not found")
    return out


def create_sql_query(c: TJClient, app_id: str, version_id: str, ds_id: str, name: str, sql: str):
    body = {
        "name": name, "kind": "mysql", "app_version_id": version_id,
        "options": {
            "mode": "sql", "query": sql,
            "enableTransformation": False, "runOnPageLoad": True,
        },
    }
    r = c.session.post(f"{c.base_url}/api/data-queries/data-sources/{ds_id}/versions/{version_id}",
                       json=body, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Create query failed: {r.status_code} {r.text[:300]}")


def execute_pivot(c: TJClient, version_id: str, config: dict, page: int = None, page_size: int = None) -> dict:
    """Call the /api/pivot-table-config/execute endpoint and return parsed rows."""
    body = {
        "app_version_id": version_id,
        "component_name": COMPONENT_NAME,
        "config": config,
    }
    if page is not None:
        body["page"] = page
    if page_size is not None:
        body["page_size"] = page_size
    r = c.session.post(f"{c.base_url}/api/pivot-table-config/execute", json=body, timeout=30)
    if not r.ok:
        raise RuntimeError(f"Execute pivot failed: {r.status_code} {r.text[:400]}")
    return r.json()


# ---- Test scenarios ----

def test_basic_sum_count(c, version_id):
    print("\n[1] Basic: row=region, SUM(revenue) + COUNT + Grand Total")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "sum", "field": "revenue"},
            {"id": "m2", "aggregator": "count"},
        ],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    print(f"  rows: {len(rows)}")
    _assert_row(rows, {"region": "APAC"}, {"_pivot_m_0": 92950.0, "_pivot_m_1": 21})
    _assert_row(rows, {"region": "EU"},   {"_pivot_m_0": 98000.0, "_pivot_m_1": 19})
    _assert_row(rows, {"region": "NA"},   {"_pivot_m_0": 87000.0, "_pivot_m_1": 15})
    # Grand totals come via grand_totals key
    gt = result.get("grand_totals") or []
    if gt:
        _eq("GT.sum", gt[0].get("_pivot_m_0"), 277950.0)
        _eq("GT.count", gt[0].get("_pivot_m_1"), 55)


def test_distinct_median(c, version_id):
    print("\n[2] Aggregators: distinct(country) + median(revenue)")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "distinct", "field": "country"},
            {"id": "m2", "aggregator": "median", "field": "revenue"},
        ],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    print(f"  distinct+median rows: {len(rows)}")
    # Just verify the shape + that results are positive/plausible
    for r in rows:
        region = r.get("region")
        dc = r.get("_pivot_m_0")
        med = r.get("_pivot_m_1")
        _eq(f"{region}.distinct_country >= 1", dc >= 1, True)
        _eq(f"{region}.median > 0", med and med > 0, True)


def test_sum_where(c, version_id):
    print("\n[3] Conditional: SUM revenue where is_paid='1'")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "sum", "field": "revenue"},
            {"id": "m2", "aggregator": "sum-where", "field": "revenue",
             "where": {"field": "is_paid", "op": "=", "value": "1"}},
        ],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    for r in rows:
        total = float(r.get("_pivot_m_0") or 0)
        paid = float(r.get("_pivot_m_1") or 0)
        _eq(f"{r.get('region')}: paid <= total", paid <= total, True)


def test_with_col_fields(c, version_id):
    print("\n[4] Row × Col pivot: region × product_category")
    config = {
        "enabled": True,
        "rowFields": ["region"], "colFields": ["product_category"],
        "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    print(f"  row×col rows: {len(rows)}")
    # Each row now has region, product_category, aggregate
    categories = set(r.get("product_category") for r in rows)
    regions = set(r.get("region") for r in rows)
    _eq("3 regions present", len(regions & {"APAC","EU","NA"}), 3)
    _eq("product_category has >=2 distinct", len(categories) >= 2, True)
    # Sum of all row×col values should equal overall 277950 (sanity check)
    total = sum(float(r.get("_pivot_m_0") or 0) for r in rows)
    _eq("row×col total == GT", total, 277950.0)


def test_sort_rowTotal_desc(c, version_id):
    print("\n[5] Backend sort: rowTotal:0 desc → NA(?), EU(?), APAC(?) by rev sum")
    # Actually NA has 87000, EU 98000, APAC 92950 → desc: EU(98000), APAC(92950), NA(87000)
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        "sort": {"key": "rowTotal:0", "direction": "desc"},
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    regions_in_order = [r.get("region") for r in rows if r.get("region")]
    _eq("sort: first region is EU", regions_in_order[0] if regions_in_order else None, "EU")
    _eq("sort: last region is NA", regions_in_order[-1] if regions_in_order else None, "NA")


def test_sort_row_asc(c, version_id):
    print("\n[6] Backend sort: row:0 asc (alphabetical)")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "count"}],
        "sort": {"key": "row:0", "direction": "asc"},
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    regions_in_order = [r.get("region") for r in rows if r.get("region")]
    # Alphabetical: APAC, EU, NA
    _eq("alpha sort position 0", regions_in_order[0] if len(regions_in_order) > 0 else None, "APAC")
    _eq("alpha sort position 1", regions_in_order[1] if len(regions_in_order) > 1 else None, "EU")
    _eq("alpha sort position 2", regions_in_order[2] if len(regions_in_order) > 2 else None, "NA")


def test_pagination(c, version_id):
    print("\n[7] Pagination: pageSize=2, verify 2 pages")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "count"}],
    }
    page0 = execute_pivot(c, version_id, config, page=0, page_size=2)
    page1 = execute_pivot(c, version_id, config, page=1, page_size=2)
    rows0 = page0.get("data", [])
    rows1 = page1.get("data", [])
    _eq("page 0 has 2 rows", len(rows0), 2)
    _eq("page 1 has 1 row", len(rows1), 1)
    _eq("total reported", page0.get("total"), 3)


def test_pagination_with_cols(c, version_id):
    print("\n[8] Pagination + col fields (DENSE_RANK): pageSize=1")
    config = {
        "enabled": True,
        "rowFields": ["region"], "colFields": ["product_category"],
        "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
    }
    result = execute_pivot(c, version_id, config, page=0, page_size=1)
    rows = result.get("data", [])
    # Page 0, size 1 row-group → all rows for the FIRST region, multiple categories
    regions_on_page = set(r.get("region") for r in rows if r.get("region"))
    _eq("page 0 contains exactly 1 region", len(regions_on_page), 1)


def test_percentile(c, version_id):
    print("\n[9] Percentile: P95(revenue) per region")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "percentile", "field": "revenue", "percentile": 0.95}],
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    for r in rows:
        p95 = r.get("_pivot_m_0")
        _eq(f"{r.get('region')}: p95 > 0", p95 and float(p95) > 0, True)


def test_invalid_aggregator_falls_back(c, version_id):
    print("\n[10] Invalid aggregator → count fallback (no crash)")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "bogus_agg"}],
    }
    try:
        result = execute_pivot(c, version_id, config)
        rows = result.get("data", [])
        _eq("fallback returned rows", len(rows) > 0, True)
    except Exception as e:
        _failed.append(("invalid aggregator", str(e), "should not crash"))


def test_cum_sum(c, version_id):
    print("\n[11] cum-sum: running total of revenue per region")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "cum-sum", "field": "revenue"}],
        "sort": {"key": "row:0", "direction": "asc"},  # force alphabetical order
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    # APAC (92950), EU (92950+98000=190950), NA (190950+87000=277950)
    vals = [(r.get("region"), r.get("_pivot_m_0")) for r in rows if r.get("region")]
    if len(vals) >= 3:
        _eq("cum-sum APAC", vals[0][1], 92950.0)
        _eq("cum-sum EU (APAC+EU)", vals[1][1], 190950.0)
        _eq("cum-sum NA (total)", vals[2][1], 277950.0)


def test_cum_count(c, version_id):
    print("\n[12] cum-count: running count per region (21, 21+19=40, 40+15=55)")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "cum-count"}],
        "sort": {"key": "row:0", "direction": "asc"},
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    vals = [(r.get("region"), r.get("_pivot_m_0")) for r in rows if r.get("region")]
    if len(vals) >= 3:
        _eq("cum-count APAC", vals[0][1], 21)
        _eq("cum-count EU (APAC+EU)", vals[1][1], 40)
        _eq("cum-count NA (total)", vals[2][1], 55)


def test_share(c, version_id):
    print("\n[13] share: each region's revenue / overall revenue (sum=1)")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "share", "field": "revenue"}],
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    # share values per region (raw numeric — frontend divides by overall)
    # Backend SQL for share just emits SUM — the "division" is in the overall grand total query
    # So _pivot_m_0 here is the SUM per region
    apac = next((r.get("_pivot_m_0") for r in rows if r.get("region") == "APAC"), None)
    _eq("share APAC raw sum", apac, 92950.0)
    # Total across all regions should equal overall
    total = sum(float(r.get("_pivot_m_0") or 0) for r in rows)
    _eq("share total matches overall", total, 277950.0)


def test_expr(c, version_id):
    print("\n[14] expr: custom expression SUM(revenue) - SUM(cost)")
    # profit per region = sum(revenue) - sum(cost)
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "sum", "field": "revenue"},
            {"id": "m2", "aggregator": "sum", "field": "cost"},
            {"id": "m3", "aggregator": "expr", "expression": "SUM(revenue) - SUM(cost)"},
        ],
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    for r in rows:
        region = r.get("region")
        rev = float(r.get("_pivot_m_0") or 0)
        cost = float(r.get("_pivot_m_1") or 0)
        profit = float(r.get("_pivot_m_2") or 0)
        # Expression result should match rev - cost within tolerance
        _eq(f"{region} expr rev-cost", profit, rev - cost, delta=0.5)


def test_stddev_variance(c, version_id):
    print("\n[15] stddev + variance: dispersion of revenue per region")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "stddev", "field": "revenue"},
            {"id": "m2", "aggregator": "variance", "field": "revenue"},
        ],
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    for r in rows:
        sd = float(r.get("_pivot_m_0") or 0)
        var = float(r.get("_pivot_m_1") or 0)
        # variance = stddev^2 (approximately)
        _eq(f"{r.get('region')}: stddev^2 ≈ variance", abs(sd*sd - var) < var*0.05, True)


def test_subtotals_multi_level(c, version_id):
    print("\n[16] Subtotals: 2-level grouping (region > country) with per-region totals")
    config = {
        "enabled": True,
        "rowFields": ["region", "country"],
        "colFields": [],
        "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        "showSubtotal": True, "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    subs = result.get("subtotals") or []
    gts = result.get("grand_totals") or []
    print(f"  leaf rows: {len(rows)}  subtotals: {len(subs)}  grand_totals: {len(gts)}")
    # Expected: 8 leaf rows (region-country pairs), subtotals per region (3), grand total
    _eq("leaf rows count", len(rows), 8)
    # Subtotal for APAC = 27800 + 41250 + 23900 = 92950
    apac_sub = next((s for s in subs if s.get("region") == "APAC" and s.get("_pivot_subtotal_level") == 0), None)
    if apac_sub:
        _eq("APAC subtotal", apac_sub.get("_pivot_m_0"), 92950.0)
    # Overall GT
    if gts:
        _eq("Grand Total sum", gts[0].get("_pivot_m_0"), 277950.0)


def test_multi_measure_complex(c, version_id):
    print("\n[17] 4 measures mixed: sum, avg, distinct, sum-where")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "sum", "field": "revenue"},
            {"id": "m2", "aggregator": "avg", "field": "revenue"},
            {"id": "m3", "aggregator": "distinct", "field": "product"},
            {"id": "m4", "aggregator": "sum-where", "field": "quantity",
             "where": {"field": "is_paid", "op": "=", "value": "1"}},
        ],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    rows = result.get("data", [])
    for r in rows:
        sum_rev = float(r.get("_pivot_m_0") or 0)
        avg_rev = float(r.get("_pivot_m_1") or 0)
        distinct_prod = int(r.get("_pivot_m_2") or 0)
        paid_qty = float(r.get("_pivot_m_3") or 0)
        _eq(f"{r.get('region')}: sum > 0", sum_rev > 0, True)
        _eq(f"{r.get('region')}: avg > 0", avg_rev > 0, True)
        _eq(f"{r.get('region')}: distinct_product in [1,10]", 1 <= distinct_prod <= 10, True)
        _eq(f"{r.get('region')}: paid_qty >= 0", paid_qty >= 0, True)


def test_gt_non_reaggregable(c, version_id):
    print("\n[18] Grand total for non-reaggregable (distinct, median) — uses overall query")
    config = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [
            {"id": "m1", "aggregator": "distinct", "field": "product"},
            {"id": "m2", "aggregator": "median", "field": "revenue"},
        ],
        "showGrandTotal": True,
    }
    result = execute_pivot(c, version_id, config)
    gts = result.get("grand_totals") or []
    if gts:
        gt = gts[0]
        distinct_all = int(gt.get("_pivot_m_0") or 0)
        med_all = float(gt.get("_pivot_m_1") or 0)
        # Distinct across all rows should be 7 (we checked earlier)
        _eq("GT distinct_product = 7 (overall)", distinct_all, 7)
        # Median should be positive
        _eq("GT median > 0", med_all > 0, True)


def test_config_roundtrip(c, version_id):
    print("\n[19] Config round-trip: CF + sort persisted and retrievable")
    cfg = {
        "enabled": True, "rowFields": ["region"], "colFields": [],
        "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        "sort": {"key": "rowTotal:0", "direction": "desc"},
        "conditionalFormats": [
            {"id": "cf1", "type": "threshold", "measureId": "m1",
             "operator": ">", "value1": 90000, "bgColor": "#D1FAE5", "textColor": "#065F46",
             "applyToTotals": False},
        ],
    }
    # Seed via DB helper — pass component_id so API can resolve it
    comp_id = get_component_id(version_id)
    c.upsert_pivot_config(version_id, COMPONENT_NAME, cfg, component_id=comp_id)
    # Read back via API
    r = c.session.get(f"{c.base_url}/api/pivot-table-config/{version_id}/{COMPONENT_NAME}", timeout=10)
    data = r.json() if r.ok else {}
    loaded = (data or {}).get("config") or {}
    _eq("round-trip rowFields", loaded.get("rowFields"), ["region"])
    _eq("round-trip sort key", (loaded.get("sort") or {}).get("key"), "rowTotal:0")
    _eq("round-trip sort dir", (loaded.get("sort") or {}).get("direction"), "desc")
    cfs = loaded.get("conditionalFormats") or []
    _eq("round-trip CF count", len(cfs), 1)
    if cfs:
        _eq("round-trip CF measureId", cfs[0].get("measureId"), "m1")
        _eq("round-trip CF bgColor", cfs[0].get("bgColor"), "#D1FAE5")


def main() -> int:
    c = TJClient()
    print(f"[setup] ToolJet: {c.base_url}  workspace: {c.workspace_slug}")

    print("[setup] Building test app...")
    app_id, version_id, comp_id = setup_app(c)
    print(f"[setup] app={app_id[:8]}... version={version_id[:8]}... comp={comp_id[:8]}...")

    tests = [
        test_basic_sum_count,
        test_distinct_median,
        test_sum_where,
        test_with_col_fields,
        test_sort_rowTotal_desc,
        test_sort_row_asc,
        test_pagination,
        test_pagination_with_cols,
        test_percentile,
        test_invalid_aggregator_falls_back,
        test_cum_sum,
        test_cum_count,
        test_share,
        test_expr,
        test_stddev_variance,
        test_subtotals_multi_level,
        test_multi_measure_complex,
        test_gt_non_reaggregable,
        test_config_roundtrip,
    ]
    for t in tests:
        try:
            t(c, version_id)
        except Exception as e:
            _failed.append((t.__name__, str(e), None))
            print(f"  ✖ {t.__name__} threw: {e}")

    print(f"\n======  {_passed} passed, {len(_failed)} failed  ======")
    if _failed:
        for n, a, e in _failed:
            print(f"  FAIL {n}: {a!r} != {e!r}")
        return 1
    print("✅ All backend E2E assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
