FROM tooljet/tooljet-ee:v3.20.60-lts

USER root

# ===================== Custom License =====================
COPY custom-license/License-EE.js /app/server/dist/ee/licensing/configs/License.js
COPY custom-license/License.js /app/server/dist/src/modules/licensing/configs/License.js

# ===================== Pyodide Packages =====================
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY scripts/add_pyodide_package.py /tmp/add_pyodide_package.py

RUN python3 /tmp/add_pyodide_package.py && \
    rm /tmp/add_pyodide_package.py && \
    apt-get purge -y python3 && \
    apt-get autoremove -y && \
    apt-get clean

# ===================== Query Folders: Backend Module (pre-built JS) =====================
# Module registration (static import from app module)
COPY query-folders/dist/module.js /app/server/dist/src/modules/query-folders/module.js

# EE dynamic imports (SubModule loads from dist/ee/ in EE edition)
COPY query-folders/dist/ee/ /app/server/dist/ee/query-folders/

# TypeORM migration (runs automatically via EE entrypoint db:migrate)
COPY query-folders/dist/migrations/1760000000000-CreateQueryFolders.js /app/server/dist/migrations/1760000000000-CreateQueryFolders.js

# Patch the EE app module.js to register QueryFoldersModule
COPY query-folders/patch-app-module.js /tmp/patch-app-module.js
RUN node /tmp/patch-app-module.js && rm /tmp/patch-app-module.js

# ===================== Query Folders: Frontend Injection =====================
COPY query-folders/inject.js /app/query-folders/inject.js
COPY query-folders/inject.css /app/query-folders/inject.css
COPY query-folders/entrypoint.sh /app/query-folders/entrypoint.sh

RUN chmod +x /app/query-folders/entrypoint.sh

# ===================== Permissions =====================
RUN chown -R appuser:0 /app/server/dist/ee/licensing/configs/License.js && \
    chown -R appuser:0 /app/server/dist/src/modules/licensing/configs/License.js && \
    chown -R appuser:0 /app/server/dist/src/modules/query-folders/ && \
    chown -R appuser:0 /app/server/dist/ee/query-folders/ && \
    chown -R appuser:0 /app/server/dist/migrations/1760000000000-CreateQueryFolders.js && \
    chown -R appuser:0 /app/query-folders/

USER appuser

ENTRYPOINT ["/app/query-folders/entrypoint.sh"]
