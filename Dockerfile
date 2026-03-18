FROM tooljet/tooljet-ee:v3.20.60-lts

# Switch to root to modify files
USER root

# ============================================================
# Query Folders Feature - Server (compiled JS overlays)
# ============================================================

# New entity: QueryFolder
COPY query-folders/server-dist/src/entities/query_folder.entity.js /app/server/dist/src/entities/
COPY query-folders/server-dist/src/entities/query_folder.entity.d.ts /app/server/dist/src/entities/
COPY query-folders/server-dist/src/entities/query_folder.entity.js.map /app/server/dist/src/entities/

# Modified entity: DataQuery (added queryFolderId, folderPosition columns)
COPY query-folders/server-dist/src/entities/data_query.entity.js /app/server/dist/src/entities/
COPY query-folders/server-dist/src/entities/data_query.entity.d.ts /app/server/dist/src/entities/
COPY query-folders/server-dist/src/entities/data_query.entity.js.map /app/server/dist/src/entities/

# New module: query-folders (controller, service, dto, constants)
COPY query-folders/server-dist/src/modules/query-folders/ /app/server/dist/src/modules/query-folders/

# EE edition resolves modules from /app/server/dist/ee/ — use wrappers that
# proxy to CE module with correct relative paths (EE path structure differs)
COPY query-folders/ee-dist/query-folders/ /app/server/dist/ee/query-folders/

# Modified: app module (registers QueryFoldersModule)
COPY query-folders/server-dist/src/modules/app/module.js /app/server/dist/src/modules/app/
COPY query-folders/server-dist/src/modules/app/module.d.ts /app/server/dist/src/modules/app/
COPY query-folders/server-dist/src/modules/app/module.js.map /app/server/dist/src/modules/app/

# Modified: modules enum (added QUERY_FOLDERS)
COPY query-folders/server-dist/src/modules/app/constants/modules.js /app/server/dist/src/modules/app/constants/
COPY query-folders/server-dist/src/modules/app/constants/modules.d.ts /app/server/dist/src/modules/app/constants/
COPY query-folders/server-dist/src/modules/app/constants/modules.js.map /app/server/dist/src/modules/app/constants/

# Migrations (compiled JS - run by typeorm at startup)
COPY query-folders/server-dist/migrations/ /app/server/dist/migrations/

# ============================================================
# Query Folders Feature - Frontend (pre-built bundle)
# ============================================================
# Frontend was built locally with query folders changes baked in.
# Replace the entire frontend build directory.
COPY query-folders/frontend-build/ /app/frontend/build/

# ============================================================
# Existing customizations
# ============================================================

# Copy the modified License.js files with UNLIMITED features
# EE Edition loads from /app/server/dist/ee/licensing/configs/License.js
COPY custom-license/License-EE.js /app/server/dist/ee/licensing/configs/License.js

# Also copy to CE path for fallback (optional)
COPY custom-license/License.js /app/server/dist/src/modules/licensing/configs/License.js

# Copy the modified MySQL plugin to override connection pool behavior
# This overrides the MySQL plugin to disable connection pooling and close connections after each query
COPY custom-mysql-plugin/lib/index.js /app/plugins/dist/packages/mysql/lib/index.js

# Add openpyxl to Pyodide repodata.json
# Install Python temporarily for the script (script uses only built-in libraries)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy script to add packages to Pyodide
COPY scripts/add_pyodide_package.py /tmp/add_pyodide_package.py

# Run script to add openpyxl and et_xmlfile to repodata.json
RUN python3 /tmp/add_pyodide_package.py && \
    rm /tmp/add_pyodide_package.py && \
    apt-get purge -y python3 && \
    apt-get autoremove -y && \
    apt-get clean

# Set ownership back to appuser
RUN chown appuser:0 /app/server/dist/ee/licensing/configs/License.js && \
    chown appuser:0 /app/server/dist/src/modules/licensing/configs/License.js && \
    chown appuser:0 /app/plugins/dist/packages/mysql/lib/index.js && \
    chown -R appuser:0 /app/frontend/build/ && \
    chown -R appuser:0 /app/server/dist/src/entities/query_folder.entity.* && \
    chown -R appuser:0 /app/server/dist/src/entities/data_query.entity.* && \
    chown -R appuser:0 /app/server/dist/src/modules/query-folders/ && \
    chown -R appuser:0 /app/server/dist/ee/query-folders/ && \
    chown appuser:0 /app/server/dist/src/modules/app/module.* && \
    chown appuser:0 /app/server/dist/src/modules/app/constants/modules.* && \
    chown -R appuser:0 /app/server/dist/migrations/1754300*

# Switch back to appuser
USER appuser

# Use the original entrypoint
ENTRYPOINT ["./server/ee-entrypoint.sh"]

