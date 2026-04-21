"""Shared fixtures & config for E2E tests."""
from __future__ import annotations

import os
from pathlib import Path

SCREENSHOT_DIR = Path(__file__).resolve().parent / "_screenshots"
SCREENSHOT_DIR.mkdir(exist_ok=True, parents=True)


def screenshot_path(name: str) -> str:
    """Return absolute path for a screenshot file."""
    return str(SCREENSHOT_DIR / f"{name}.png")


TJ_URL = os.environ.get("TOOLJET_URL", "http://localhost:8080")


def fixed_data_rows():
    """Deterministic test data (in-memory JSON) used by several tests.

    Columns: region, product, revenue, units, is_paid.
    Matches a simple business scenario and lets us assert exact aggregates.
    """
    return [
        {"region": "APAC", "product": "Phone", "revenue": 100, "units": 2, "is_paid": "true"},
        {"region": "APAC", "product": "Laptop", "revenue": 300, "units": 1, "is_paid": "true"},
        {"region": "APAC", "product": "Phone", "revenue": 150, "units": 3, "is_paid": "false"},
        {"region": "EU", "product": "Phone", "revenue": 200, "units": 4, "is_paid": "true"},
        {"region": "EU", "product": "Laptop", "revenue": 500, "units": 2, "is_paid": "true"},
        {"region": "NA", "product": "Phone", "revenue": 400, "units": 5, "is_paid": "false"},
        {"region": "NA", "product": "Laptop", "revenue": 700, "units": 3, "is_paid": "true"},
    ]
