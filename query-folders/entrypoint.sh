#!/bin/bash
set -e

# ===================== Inject frontend scripts =====================
for BUILD_DIR in /app/frontend/build /app/client/build; do
  if [ -d "$BUILD_DIR" ]; then
    mkdir -p "$BUILD_DIR/query-folders"
    cp /app/query-folders/inject.js "$BUILD_DIR/query-folders/inject.js"
    cp /app/query-folders/inject.css "$BUILD_DIR/query-folders/inject.css"

    if [ -f "$BUILD_DIR/index.html" ] && ! grep -q "query-folders/inject" "$BUILD_DIR/index.html" 2>/dev/null; then
      sed -i 's|</head>|<link rel="stylesheet" href="/query-folders/inject.css"><script defer src="/query-folders/inject.js"></script></head>|' "$BUILD_DIR/index.html"
      echo "[QueryFolders] Frontend injected into $BUILD_DIR/index.html"
    fi
    break
  fi
done

# ===================== Use original EE entrypoint =====================
exec /app/server/ee-entrypoint.sh "$@"
