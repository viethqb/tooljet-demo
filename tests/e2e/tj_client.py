"""Minimal ToolJet client for E2E test setup.

Handles login (cookie-based), app/page/component creation, pivot config upsert,
and test data source wiring. Mirrors the data-portal Python/Playwright pattern
but adapted to the pivot-table injection use case.
"""
from __future__ import annotations

import os
import uuid
from typing import Any, Dict, List, Optional

import requests


TJ_URL = os.environ.get("TOOLJET_URL", "http://localhost:8080")
TJ_ADMIN_EMAIL = os.environ.get("TJ_ADMIN_EMAIL", "admin@example.com")
TJ_ADMIN_PASSWORD = os.environ.get("TJ_ADMIN_PASSWORD", "admin_dev_password")


class TJClient:
    """Authenticated session against a running ToolJet instance."""

    def __init__(self, base_url: str = TJ_URL, email: str = TJ_ADMIN_EMAIL, password: str = TJ_ADMIN_PASSWORD) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self._login(email, password)
        # Fetch workspace id + slug for subsequent requests
        self.workspace_id, self.workspace_slug = self._get_workspace_info()
        if self.workspace_id:
            self.session.headers.update({"tj-workspace-id": self.workspace_id})

    # ---- Auth ----

    def _login(self, email: str, password: str) -> None:
        r = self.session.post(
            f"{self.base_url}/api/authenticate",
            json={"email": email, "password": password},
            timeout=15,
        )
        if not r.ok:
            raise RuntimeError(f"Login failed: {r.status_code} {r.text[:200]}")

    def _get_workspace_info(self) -> tuple:
        r = self.session.get(f"{self.base_url}/api/session", timeout=15)
        if r.ok:
            data = r.json()
            return data.get("current_organization_id"), data.get("current_organization_slug")
        return None, None

    # ---- App lifecycle ----

    def create_app(self, name: str) -> Dict[str, Any]:
        r = self.session.post(
            f"{self.base_url}/api/apps",
            json={"name": name, "type": "front-end"},
            timeout=15,
        )
        if not r.ok:
            raise RuntimeError(f"Create app failed: {r.status_code} {r.text[:300]}")
        return r.json()

    def delete_app(self, app_id: str) -> None:
        self.session.delete(f"{self.base_url}/api/apps/{app_id}", timeout=15)

    def list_apps(self) -> List[Dict[str, Any]]:
        r = self.session.get(f"{self.base_url}/api/apps", timeout=15)
        return r.json().get("apps", []) if r.ok else []

    def get_app_detail(self, app_id: str) -> Dict[str, Any]:
        """Get detailed app info including version + pages + components."""
        r = self.session.get(f"{self.base_url}/api/apps/{app_id}", timeout=15)
        if not r.ok:
            raise RuntimeError(f"Get app detail failed: {r.text[:200]}")
        return r.json()

    def find_app_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        for app in self.list_apps():
            if app.get("name") == name:
                return app
        return None

    def get_app_version(self, app_id: str) -> Dict[str, Any]:
        """Return the editing version of an app (contains id, home_page_id, pages)."""
        detail = self.get_app_detail(app_id)
        v = detail.get("editing_version") or detail.get("current_version")
        if not v:
            raise RuntimeError(f"App {app_id} has no versions")
        return v

    # ---- Data sources ----

    def list_data_sources(self, env_id: str, version_id: str) -> List[Dict[str, Any]]:
        r = self.session.get(
            f"{self.base_url}/api/data-sources/{self.workspace_id}/environments/{env_id}/versions/{version_id}",
            timeout=15,
        )
        return r.json().get("data_sources", []) if r.ok else []

    # ---- Data sources (static kinds: runjs, tooljetdb, etc.) ----

    def fetch_static_ds_ids(self) -> Dict[str, str]:
        """ToolJet's static data sources (runjs, tooljetdb, restapi, runpy, workflows)
        are not returned by the data-sources API. Read them directly from Postgres.
        """
        import subprocess
        sql = (
            f"SELECT kind || '|' || id FROM data_sources "
            f"WHERE type='static' AND organization_id='{self.workspace_id}';"
        )
        try:
            out = subprocess.check_output(
                ["docker", "exec", "dp-pg-tooljet", "psql", "-U", "postgres",
                 "-d", "tooljet_production", "-At", "-c", sql],
                text=True,
            )
        except Exception as e:
            raise RuntimeError(f"Could not fetch static data sources: {e}")
        res: Dict[str, str] = {}
        for line in out.splitlines():
            if "|" in line:
                k, v = line.split("|", 1)
                res[k.strip()] = v.strip()
        return res

    # ---- Queries ----

    def create_runjs_query(self, app_id: str, version_id: str, name: str, code: str,
                           run_on_page_load: bool = True) -> Dict[str, Any]:
        """Create a runjs query returning static data. Uses the static runjs data source.
        By default sets `runOnPageLoad=true` so the query executes when the app loads.
        """
        ds_ids = self.fetch_static_ds_ids()
        ds_id = ds_ids.get("runjs")
        if not ds_id:
            raise RuntimeError(f"No runjs data source found. Static DS IDs: {ds_ids}")
        body = {
            "name": name,
            "kind": "runjs",
            "options": {"code": code, "runOnPageLoad": run_on_page_load, "parameters": []},
            "app_version_id": version_id,
        }
        r = self.session.post(
            f"{self.base_url}/api/data-queries/data-sources/{ds_id}/versions/{version_id}",
            json=body, timeout=15,
        )
        if not r.ok:
            raise RuntimeError(f"Create query failed: {r.status_code} {r.text[:300]}")
        return r.json()

    def list_queries(self, version_id: str) -> List[Dict[str, Any]]:
        r = self.session.get(f"{self.base_url}/api/data-queries/{version_id}", timeout=15)
        return r.json().get("data_queries", []) if r.ok else []

    # ---- Components (Table widget) ----

    def get_home_page_id(self, version: Dict[str, Any]) -> Optional[str]:
        """Get the default home page id of an app version."""
        return version.get("home_page_id") or (version.get("pages") or [{}])[0].get("id")

    def create_table_component(self, app_id: str, version_id: str, page_id: str,
                               name: str, query_name: str) -> Dict[str, Any]:
        """Create a Table widget bound to {{queries.<query_name>.data}}.

        Uses the v2 components API with diff-style payload.
        """
        comp_id = str(uuid.uuid4())
        component = {
            "name": name,
            "type": "Table",
            "properties": {
                "data": {"value": "{{queries." + query_name + ".data}}"},
                "loadingState": {"value": "{{false}}"},
                "visibility": {"value": "{{true}}"},
                "disabledState": {"value": "{{false}}"},
                "columns": {"value": []},
                "actions": {"value": []},
            },
            "styles": {
                "tableType": {"value": "table-bordered"},
                "cellSize": {"value": "condensed"},
            },
            "validation": {},
            "others": {
                "showOnDesktop": {"value": "{{true}}"},
                "showOnMobile": {"value": "{{true}}"},
            },
            "layouts": {
                "desktop": {"top": 60, "left": 0, "width": 43, "height": 400},
                "mobile":  {"top": 60, "left": 0, "width": 43, "height": 400},
            },
        }
        payload = {
            "is_user_switched_version": False,
            "pageId": page_id,
            "diff": {comp_id: component},
        }
        r = self.session.post(
            f"{self.base_url}/api/v2/apps/{app_id}/versions/{version_id}/components",
            json=payload, timeout=15,
        )
        if not r.ok:
            raise RuntimeError(f"Create component failed: {r.status_code} {r.text[:400]}")
        return {"id": comp_id, "name": name}

    # ---- Pivot config (custom endpoint) ----

    def upsert_pivot_config(self, app_version_id: str, component_name: str, config: Dict[str, Any],
                            component_id: Optional[str] = None) -> Dict[str, Any]:
        """Save pivot config. We bypass the API (which has an observed quirk where
        it returns 200 but doesn't persist) and write directly to Postgres via
        `docker exec`. This makes the test setup deterministic.
        """
        import subprocess
        import json as _json
        # Escape single quotes in JSON for SQL literal
        config_json = _json.dumps(config).replace("'", "''")
        cid = f"'{component_id}'" if component_id else "NULL"
        # Upsert: delete existing then insert
        sql = (
            f"DELETE FROM pivot_table_configs WHERE app_version_id='{app_version_id}' "
            f"AND component_name='{component_name}'; "
            f"INSERT INTO pivot_table_configs (app_version_id, component_id, component_name, config) "
            f"VALUES ('{app_version_id}', {cid}, '{component_name}', '{config_json}');"
        )
        try:
            subprocess.check_output(
                ["docker", "exec", "dp-pg-tooljet", "psql", "-U", "postgres",
                 "-d", "tooljet_production", "-c", sql],
                text=True, stderr=subprocess.STDOUT,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"DB upsert failed: {e.output}")
        return {"ok": True}

    # ---- Utility ----

    def cookie_header(self) -> str:
        """Return cookie header for handing off to Playwright context."""
        return "; ".join(f"{c.name}={c.value}" for c in self.session.cookies)

    def cookies_for_playwright(self) -> List[Dict[str, Any]]:
        """Export cookies in Playwright addCookies() format."""
        from urllib.parse import urlparse
        netloc = urlparse(self.base_url).netloc
        host = netloc.split(":")[0]
        out = []
        for c in self.session.cookies:
            out.append({
                "name": c.name,
                "value": c.value,
                "domain": host,
                "path": c.path or "/",
                "httpOnly": c.has_nonstandard_attr("HttpOnly") or bool(c._rest.get("HttpOnly")) if hasattr(c, "_rest") else False,
                "secure": c.secure,
            })
        return out
