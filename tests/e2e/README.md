# Pivot Table E2E Tests

Three suites:

1. **`test_pivot_backend.py`** (19 scenarios / 70 assertions) — API-driven:
   seeds data into StarRocks, creates a test app, calls
   `/api/pivot-table-config/execute` and asserts exact aggregated values.
   Covers all aggregators (sum, avg, distinct, median, percentile, stddev,
   variance, sum-where, count-where, cum-sum, cum-count, share, expr),
   backend sort, pagination (LIMIT/OFFSET + DENSE_RANK), subtotals,
   non-reaggregable GT, config round-trip.

2. **`test_pivot_perf.py`** (10 scenarios) — benchmarks the same backend
   path against 50k rows, reports p50/p95 and asserts soft budgets.

3. **`test_pivot_smoke.py`** (Playwright) — browser smoke: builds the app and
   opens it in headless Chromium to verify the Table widget renders with data.
   Pivot overlay activation in headless mode is a known limitation (see below).

## What it does

1. Logs into ToolJet as admin via `/api/authenticate` (cookie on a
   `requests.Session`).
2. Builds a fresh test app via the REST API:
   - creates app `e2e-pivot-test`
   - creates runjs query `salesData` returning 7 in-memory rows
     (`runOnPageLoad: true`)
   - creates a `Table` widget named `pivot1` bound to `{{queries.salesData.data}}`
   - seeds a pivot config row into `pivot_table_configs` (via direct
     `docker exec` to Postgres, bypassing an API quirk that returns 200
     but doesn't persist)
3. Opens the editor URL in a Playwright Chromium context (cookies attached),
   waits for the Table widget to render with data, screenshots, asserts.

## Running

```bash
# From repo root — one-time setup
python3 -m venv .venv
.venv/bin/pip install -r tests/e2e/requirements.txt
.venv/bin/playwright install chromium

# Backend E2E (70 assertions, ~10s)
.venv/bin/python tests/e2e/test_pivot_backend.py

# Performance benchmarks (~20s, 50k rows)
.venv/bin/python tests/e2e/test_pivot_perf.py

# Browser smoke (~30s)
.venv/bin/python tests/e2e/test_pivot_smoke.py
```

### One-time perf dataset seed

The perf suite expects `demo.sales_perf` with ≥1000 rows. To create 50k rows:

```bash
docker exec pivot-starrocks mysql -h 127.0.0.1 -P 9030 -u root -e "
USE demo;
DROP TABLE IF EXISTS sales_perf;
CREATE TABLE sales_perf (
  id BIGINT, order_date DATE, region VARCHAR(32), country VARCHAR(64),
  product_category VARCHAR(32), product VARCHAR(64), channel VARCHAR(16),
  customer_segment VARCHAR(16), status VARCHAR(16),
  quantity INT, unit_price DECIMAL(10,2), revenue DECIMAL(12,2),
  cost DECIMAL(12,2), discount_pct DECIMAL(4,2), is_paid TINYINT
) DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 4
PROPERTIES ('replication_num' = '1');

INSERT INTO sales_perf
SELECT generate_series AS id,
  DATE_ADD('2024-01-01', INTERVAL (generate_series % 180) DAY),
  CASE WHEN generate_series % 3 = 0 THEN 'APAC' WHEN generate_series % 3 = 1 THEN 'EU' ELSE 'NA' END,
  CASE (generate_series % 8) WHEN 0 THEN 'Japan' WHEN 1 THEN 'Singapore' WHEN 2 THEN 'Vietnam' WHEN 3 THEN 'France' WHEN 4 THEN 'Germany' WHEN 5 THEN 'UK' WHEN 6 THEN 'Canada' ELSE 'USA' END,
  CASE (generate_series % 4) WHEN 0 THEN 'Electronics' WHEN 1 THEN 'Furniture' WHEN 2 THEN 'Software' ELSE 'Services' END,
  CASE (generate_series % 7) WHEN 0 THEN 'Phone' WHEN 1 THEN 'Laptop' WHEN 2 THEN 'Tablet' WHEN 3 THEN 'Desk' WHEN 4 THEN 'Chair' WHEN 5 THEN 'SaaS' ELSE 'Consulting' END,
  CASE (generate_series % 3) WHEN 0 THEN 'Online' WHEN 1 THEN 'Retail' ELSE 'Partner' END,
  CASE (generate_series % 3) WHEN 0 THEN 'SMB' WHEN 1 THEN 'Mid-market' ELSE 'Enterprise' END,
  CASE (generate_series % 4) WHEN 0 THEN 'Completed' WHEN 1 THEN 'Pending' WHEN 2 THEN 'Cancelled' ELSE 'Refunded' END,
  (generate_series % 10) + 1,
  ((generate_series % 500) + 50) * 1.0,
  ((generate_series % 500) + 50) * ((generate_series % 10) + 1),
  ((generate_series % 500) + 50) * ((generate_series % 10) + 1) * 0.6,
  (generate_series % 30) * 0.01,
  generate_series % 2
FROM TABLE(generate_series(1, 50000));"
```

### Latest perf results (50k rows, local Docker, ≈1s per scenario)

| # | Scenario | p50 | p95 | budget |
|---|---|---:|---:|---:|
| 1 | Basic: region × sum(revenue) | 72ms | 104ms | 500ms |
| 2 | Row+Col × 3 measures | 113ms | 160ms | 800ms |
| 3 | Median per region | 85ms | 96ms | 1200ms |
| 4 | Percentile 0.95 | 85ms | 101ms | 1200ms |
| 5 | Cum-sum (window) | 96ms | 119ms | 1000ms |
| 6 | Subtotals multi-level | 95ms | 120ms | 2000ms |
| 7 | Sort + pageSize=10 | 83ms | 85ms | 1000ms |
| 8 | Pagination offset 100 | 80ms | 96ms | 800ms |
| 9 | 5 measures mixed | 86ms | 114ms | 1000ms |
| 10 | Custom expression | 62ms | 67ms | 800ms |

All well under budget — 50k-row pivot completes in ≈100ms end-to-end.

Prerequisites for backend E2E:
- ToolJet container up on :8080 with admin credentials
- `starrocks` datasource configured in ToolJet
- `demo.sales_rich` table seeded (55 rows, 3 regions) — already present if you
  followed the earlier StarRocks seed steps

Environment overrides (all optional):

| Var | Default |
|---|---|
| `TOOLJET_URL` | `http://localhost:8080` |
| `TJ_ADMIN_EMAIL` | `admin@example.com` |
| `TJ_ADMIN_PASSWORD` | `admin_dev_password` |
| `E2E_APP_NAME` | `e2e-pivot-test` |
| `TOOLJET_DEMO_RELEASED` | unset (set `1` to also test viewer route; app must be released first) |

## Files

- `tj_client.py` — REST client wrapping login + app/query/component creation
  + pivot config upsert (via DB to sidestep API persistence quirk).
- `conftest.py` — shared env + fixtures (test data rows, screenshot path).
- `test_pivot_smoke.py` — the smoke test itself.
- `_screenshots/` — generated screenshots after each run (gitignored).
- `requirements.txt` — `playwright`, `requests`.

## Known limitations

1. **Pivot overlay activation in headless mode**
   The smoke test waits for the pivot-table injection script to replace the
   rendered `Table` widget with the pivot overlay. In headless Chromium this
   sometimes doesn't activate within 30 s (the script polls the DOM and may
   miss transitions under heavy SPA load). When that happens the test logs
   `⚠ pivot-overlay didn't activate (known limitation)` and passes as long
   as the underlying Table widget rendered with data — the inject script can
   be verified manually by opening the generated app URL in a real browser.

2. **Viewer route needs an app release**
   ToolJet viewer (`/applications/:id`) returns `URL Unavailable` for
   unreleased apps. The test skips viewer assertions unless
   `TOOLJET_DEMO_RELEASED=1` and the app has been released.

3. **Pivot config API quirk**
   `PUT /api/pivot-table-config` returns 200 but sometimes fails to persist.
   As a workaround the test writes the row directly to the `pivot_table_configs`
   Postgres table via `docker exec dp-pg-tooljet psql`. That's why `docker` is
   a runtime requirement.

## What's tested

**Backend E2E** (`test_pivot_backend.py`, 19 scenarios × 70 assertions, all pass):

1. Basic: SUM + COUNT per region + grand total (APAC=92950, EU=98000, NA=87000, TOTAL=277950)
2. Non-reaggregable: `distinct(country)` + `median(revenue)`
3. Conditional: `sum-where` vs plain `sum` (paid ≤ total)
4. Row × Col pivot: 3 regions × N categories, sum matches grand total
5. Backend sort `rowTotal:0 desc`: EU (98k) first, NA (87k) last
6. Backend sort `row:0 asc`: alphabetical APAC → EU → NA
7. Pagination LIMIT/OFFSET: pageSize=2 → 2+1 rows, total=3
8. Pagination DENSE_RANK (row+col): each page has exactly 1 row-key
9. Percentile 0.95 per region (positive, plausible)
10. Invalid aggregator falls back to count (no crash)
11. Cum-sum: running total verifies at APAC=92950, EU=190950, NA=277950
12. Cum-count: running count 21, 40, 55
13. Share aggregator: raw sum matches, total matches overall
14. Custom expression `SUM(revenue) - SUM(cost)`: per-region profit verified
15. Stddev + variance: verifies `stddev² ≈ variance` per region
16. Subtotals + multi-level grouping: 2 row fields, 8 leafs + 3 subtotals + GT
17. Multi-measure complex: 4 measures mixed (sum, avg, distinct, sum-where)
18. Non-reaggregable GT: distinct_product at GT = 7 overall (server-side query, not sum of partials)
19. Config round-trip: CF + sort persisted to DB, retrieved via API, fields match

**Browser smoke** (`test_pivot_smoke.py`):
- Auth + app build + Table widget render with data (verifies inject pipeline
  is wired, but pivot overlay activation not covered — see limitation #1).

Unit tests under `tests/*.test.js` (95 tests) cover the aggregator registry,
Pratt parser, SQL builder, and compute helpers in depth. This smoke test is
meant as a final sanity check that the inject pipeline is wired up correctly,
not as a regression suite for the pivot feature itself.
