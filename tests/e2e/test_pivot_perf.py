#!/usr/bin/env python3
"""Performance benchmarks for pivot backend.

Executes representative pivot configs against `demo.sales_perf` (50k rows on
StarRocks) and reports p50 / p95 latencies. Asserts soft thresholds so CI
flags big regressions without flaking on noise.

Usage:
    .venv/bin/python tests/e2e/test_pivot_perf.py

Scenarios tested:
  1. Basic (1 row-field, sum)            target p95 <  500 ms
  2. Row+Col (2 fields, 3 measures)      target p95 <  800 ms
  3. Median (non-reaggregable)           target p95 < 1200 ms
  4. Percentile(0.95)                    target p95 < 1200 ms
  5. Cum-sum (window function)           target p95 < 1000 ms
  6. Subtotals multi-level (2 rowFields) target p95 < 2000 ms (multiple queries)
  7. Sort rowTotal DESC + pagination     target p95 < 1000 ms
  8. Pagination page 10 (offset 100)     target p95 <  800 ms
  9. Multi-measure (5 measures)          target p95 < 1000 ms
 10. Expr (custom expression)            target p95 <  800 ms

Each scenario runs N=5 warm + 5 measured trials. Warm-up allows JIT/plan cache.
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tj_client import TJClient


APP_NAME = "e2e-pivot-perf"
QUERY_NAME = "salesPerf"
COMPONENT_NAME = "pivot1"
STARROCKS_DS_NAME = "starrocks"
PERF_TABLE = "demo.sales_perf"


_results: List[Dict[str, Any]] = []


def setup_app(c: TJClient):
    """Create or recreate the perf app and bind to sales_perf via StarRocks."""
    old = c.find_app_by_name(APP_NAME)
    if old:
        c.delete_app(old["id"])
    app = c.create_app(APP_NAME)
    v = c.get_app_version(app["id"])
    ds_id = _get_datasource_id()
    _create_query(c, app["id"], v["id"], ds_id, QUERY_NAME,
                  f"SELECT order_date, region, country, product_category, product, channel, "
                  f"customer_segment, status, quantity, unit_price, revenue, cost, discount_pct, is_paid "
                  f"FROM {PERF_TABLE}")
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


def _get_datasource_id() -> str:
    sql = f"SELECT id FROM data_sources WHERE name='{STARROCKS_DS_NAME}' LIMIT 1"
    out = subprocess.check_output(
        ["docker", "exec", "dp-pg-tooljet", "psql", "-U", "postgres",
         "-d", "tooljet_production", "-At", "-c", sql], text=True).strip()
    if not out:
        raise RuntimeError(f"StarRocks datasource not found")
    return out


def _create_query(c: TJClient, app_id: str, version_id: str, ds_id: str, name: str, sql: str):
    body = {
        "name": name, "kind": "mysql", "app_version_id": version_id,
        "options": {"mode": "sql", "query": sql, "enableTransformation": False, "runOnPageLoad": True},
    }
    r = c.session.post(f"{c.base_url}/api/data-queries/data-sources/{ds_id}/versions/{version_id}",
                       json=body, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Create query failed: {r.status_code} {r.text[:200]}")


def _execute_pivot(c: TJClient, version_id: str, config: Dict[str, Any],
                   page: int = None, page_size: int = None) -> Dict[str, Any]:
    body = {"app_version_id": version_id, "component_name": COMPONENT_NAME, "config": config}
    if page is not None:
        body["page"] = page
    if page_size is not None:
        body["page_size"] = page_size
    r = c.session.post(f"{c.base_url}/api/pivot-table-config/execute", json=body, timeout=60)
    if not r.ok:
        raise RuntimeError(f"Execute failed: {r.status_code} {r.text[:300]}")
    return r.json()


def _time_scenario(name: str, fn: Callable[[], Dict[str, Any]], *,
                   warmup: int = 3, measured: int = 5, p95_ms: float = 1000.0) -> None:
    """Run fn warmup+measured times, report p50/p95."""
    # Warm-up (not counted)
    for _ in range(warmup):
        fn()
    # Measured
    durations_ms: List[float] = []
    result_sample = None
    for _ in range(measured):
        t0 = time.perf_counter()
        result = fn()
        dt = (time.perf_counter() - t0) * 1000
        durations_ms.append(dt)
        result_sample = result
    p50 = statistics.median(durations_ms)
    p95 = statistics.quantiles(durations_ms, n=20)[18] if len(durations_ms) >= 5 else max(durations_ms)
    avg = sum(durations_ms) / len(durations_ms)
    rows = len((result_sample or {}).get("data") or [])
    pass_ = p95 <= p95_ms
    status = "✔" if pass_ else "✖"
    print(f"  {status} {name}")
    print(f"      p50={p50:.0f}ms  p95={p95:.0f}ms  avg={avg:.0f}ms  rows={rows}  budget={p95_ms:.0f}ms")
    _results.append({"name": name, "p50": p50, "p95": p95, "avg": avg, "rows": rows,
                     "budget": p95_ms, "pass": pass_})


def run_scenarios(c: TJClient, version_id: str):
    print("\n=========  PERF BENCHMARKS  (source: 50k rows)  =========")

    # 1. Basic
    _time_scenario(
        "[1] Basic: region × sum(revenue)",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        }),
        p95_ms=500,
    )

    # 2. Row+Col
    _time_scenario(
        "[2] Row+Col: region × product_category × 3 measures",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": ["product_category"],
            "measures": [
                {"id": "m1", "aggregator": "sum", "field": "revenue"},
                {"id": "m2", "aggregator": "count"},
                {"id": "m3", "aggregator": "avg", "field": "quantity"},
            ],
        }),
        p95_ms=800,
    )

    # 3. Median
    _time_scenario(
        "[3] Median per region",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "median", "field": "revenue"}],
        }),
        p95_ms=1200,
    )

    # 4. Percentile
    _time_scenario(
        "[4] Percentile 0.95 per region",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "percentile", "field": "revenue", "percentile": 0.95}],
        }),
        p95_ms=1200,
    )

    # 5. Cum-sum
    _time_scenario(
        "[5] Cum-sum (window) by date",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["order_date"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "cum-sum", "field": "revenue"}],
        }),
        p95_ms=1000,
    )

    # 6. Subtotals multi-level
    _time_scenario(
        "[6] Subtotals: region > country (multi-query path)",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region", "country"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
            "showSubtotal": True, "showGrandTotal": True,
        }),
        p95_ms=2000,
    )

    # 7. Sort + pagination
    _time_scenario(
        "[7] Sort rowTotal desc + pageSize=10",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["product"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
            "sort": {"key": "rowTotal:0", "direction": "desc"},
        }, page=0, page_size=10),
        p95_ms=1000,
    )

    # 8. Pagination deep offset
    _time_scenario(
        "[8] Pagination page=10 (offset 100)",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["order_date"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "sum", "field": "revenue"}],
        }, page=10, page_size=10),
        p95_ms=800,
    )

    # 9. Multi-measure (5)
    _time_scenario(
        "[9] 5 measures mixed",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": [],
            "measures": [
                {"id": "m1", "aggregator": "sum", "field": "revenue"},
                {"id": "m2", "aggregator": "count"},
                {"id": "m3", "aggregator": "avg", "field": "quantity"},
                {"id": "m4", "aggregator": "distinct", "field": "product"},
                {"id": "m5", "aggregator": "sum-where", "field": "revenue",
                 "where": {"field": "is_paid", "op": "=", "value": "1"}},
            ],
        }),
        p95_ms=1000,
    )

    # 10. Expr
    _time_scenario(
        "[10] Custom expression: SUM(revenue) - SUM(cost)",
        lambda: _execute_pivot(c, version_id, {
            "enabled": True, "rowFields": ["region"], "colFields": [],
            "measures": [{"id": "m1", "aggregator": "expr",
                          "expression": "SUM(revenue) - SUM(cost)"}],
        }),
        p95_ms=800,
    )


def summary():
    print("\n\n=========  SUMMARY  =========")
    passed = sum(1 for r in _results if r["pass"])
    failed = [r for r in _results if not r["pass"]]
    print(f"\n{len(_results)} scenarios total — {passed} within budget, {len(failed)} over budget")
    print("\n| Scenario | p50 | p95 | budget | status |")
    print("| --- | ---: | ---: | ---: | :---: |")
    for r in _results:
        status = "✔" if r["pass"] else "✖ OVER"
        print(f"| {r['name']} | {r['p50']:.0f}ms | {r['p95']:.0f}ms | {r['budget']:.0f}ms | {status} |")
    if failed:
        print(f"\n⚠  {len(failed)} scenario(s) over budget:")
        for r in failed:
            ratio = r["p95"] / r["budget"]
            print(f"    {r['name']}: {r['p95']:.0f}ms vs {r['budget']:.0f}ms ({ratio:.1f}×)")
        return 1
    print("\n✅ All scenarios within p95 budget")
    return 0


def main() -> int:
    c = TJClient()
    # Verify perf dataset exists
    out = subprocess.check_output(
        ["docker", "exec", "pivot-starrocks", "mysql", "-h", "127.0.0.1", "-P", "9030",
         "-u", "root", "-N", "-e", f"SELECT COUNT(*) FROM {PERF_TABLE}"],
        text=True,
    ).strip()
    n = int(out.split()[-1])
    print(f"[setup] sales_perf row count: {n:,}")
    if n < 1000:
        print(f"[setup] ⚠ table has <1000 rows; seed first (see README)")
        return 1

    print(f"[setup] Building test app...")
    app_id, version_id, _ = setup_app(c)
    print(f"[setup] version={version_id[:8]}...")

    run_scenarios(c, version_id)
    return summary()


if __name__ == "__main__":
    sys.exit(main())
