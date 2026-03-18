#!/usr/bin/env python3
"""
Script to add openpyxl and et_xmlfile to Pyodide repodata.json
"""
import json
import hashlib
import urllib.request
import sys
import os
from pathlib import Path


def calculate_sha256(file_path):
    """Calculate SHA256 hash of a file"""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def download_package(package_name, version, pyodide_dir):
    """Download package wheel from PyPI"""
    url = f"https://pypi.org/pypi/{package_name}/{version}/json"

    try:
        with urllib.request.urlopen(url) as response:
            data = json.loads(response.read())

        # Find wheel file (prefer py2.py3-none-any or py3-none-any)
        wheels = data.get("urls", [])
        wheel = None
        for w in wheels:
            if w.get("packagetype") == "bdist_wheel":
                filename = w.get("filename", "")
                # Prefer universal wheels
                if "py2.py3-none-any" in filename or "py3-none-any" in filename:
                    wheel = w
                    break

        if not wheel:
            # Fallback to any wheel
            for w in wheels:
                if w.get("packagetype") == "bdist_wheel":
                    wheel = w
                    break

        if not wheel:
            raise Exception(f"No wheel found for {package_name} {version}")

        # Download wheel
        wheel_url = wheel["url"]
        filename = wheel["filename"]
        filepath = pyodide_dir / filename

        print(f"Downloading {filename}...")
        urllib.request.urlretrieve(wheel_url, filepath)

        return filename, filepath
    except Exception as e:
        print(f"Error downloading {package_name}: {e}", file=sys.stderr)
        raise


def get_package_imports(package_name):
    """Get import names for a package"""
    import_map = {
        "openpyxl": ["openpyxl"],
        "et_xmlfile": ["et_xmlfile"],
    }
    return import_map.get(package_name, [package_name.replace("-", "_")])


def get_package_dependencies(package_name):
    """Get dependencies for a package"""
    deps_map = {
        "openpyxl": ["et_xmlfile"],
        "et_xmlfile": [],
    }
    return deps_map.get(package_name, [])


def add_package_to_repodata(package_name, version, pyodide_dir, repodata_path):
    """Add package to repodata.json"""
    # Download package
    filename, filepath = download_package(package_name, version, pyodide_dir)

    # Calculate SHA256
    sha256 = calculate_sha256(filepath)

    # Read repodata.json
    with open(repodata_path, "r") as f:
        repodata = json.load(f)

    # Create package entry
    package_entry = {
        "name": package_name,
        "version": version,
        "file_name": filename,
        "install_dir": "site",
        "sha256": sha256,
        "package_type": "package",
        "imports": get_package_imports(package_name),
        "depends": get_package_dependencies(package_name),
    }

    # Add to packages
    if package_name not in repodata["packages"]:
        repodata["packages"][package_name] = package_entry
        print(f"Added {package_name} to repodata.json")
    else:
        print(f"Warning: {package_name} already exists in repodata.json, updating...")
        repodata["packages"][package_name] = package_entry

    # Write back
    with open(repodata_path, "w") as f:
        json.dump(repodata, f, separators=(",", ":"))

    print(f"Successfully added {package_name} {version} to repodata.json")


def main():
    # Packages to add: (name, version)
    packages = [
        ("et_xmlfile", "2.0.0"),  # Dependency of openpyxl
        ("openpyxl", "3.0.7"),  # Main package
    ]

    # Get paths
    pyodide_dir = Path("/app/frontend/build/assets/libs/pyodide-0.23.2")
    repodata_path = pyodide_dir / "repodata.json"

    if not repodata_path.exists():
        print(f"Error: repodata.json not found at {repodata_path}", file=sys.stderr)
        sys.exit(1)

    # Ensure directory exists
    pyodide_dir.mkdir(parents=True, exist_ok=True)

    # Add packages (dependencies first)
    for package_name, version in packages:
        try:
            add_package_to_repodata(package_name, version, pyodide_dir, repodata_path)
        except Exception as e:
            print(f"Failed to add {package_name}: {e}", file=sys.stderr)
            sys.exit(1)

    print("All packages added successfully!")


if __name__ == "__main__":
    main()
