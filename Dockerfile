FROM tooljet/tooljet-ee:v3.20.126-lts

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
COPY query-folders/dist/module.js /app/server/dist/src/modules/query-folders/module.js
COPY query-folders/dist/ee/ /app/server/dist/ee/query-folders/
COPY query-folders/dist/migrations/1760000000000-CreateQueryFolders.js /app/server/dist/migrations/1760000000000-CreateQueryFolders.js

COPY query-folders/patch-app-module.js /tmp/patch-app-module.js
RUN node /tmp/patch-app-module.js && rm /tmp/patch-app-module.js

# ===================== Query Folders: Frontend Injection =====================
COPY query-folders/inject.js /app/query-folders/inject.js
COPY query-folders/inject.css /app/query-folders/inject.css
COPY query-folders/entrypoint.sh /app/query-folders/entrypoint.sh

RUN chmod +x /app/query-folders/entrypoint.sh

# ===================== Pivot Table Config: Backend Module (pre-built JS) =====================
COPY pivot-table-config/dist/module.js /app/server/dist/src/modules/pivot-table-config/module.js
COPY pivot-table-config/dist/ee/ /app/server/dist/ee/pivot-table-config/
COPY pivot-table-config/dist/migrations/1760100000000-CreatePivotTableConfig.js /app/server/dist/migrations/1760100000000-CreatePivotTableConfig.js
COPY pivot-table-config/dist/migrations/1760200000000-AddComponentIdToPivotConfig.js /app/server/dist/migrations/1760200000000-AddComponentIdToPivotConfig.js
COPY pivot-table-config/dist/migrations/1760300000000-CleanupOrphanedPivotConfigs.js /app/server/dist/migrations/1760300000000-CleanupOrphanedPivotConfigs.js

COPY pivot-table-config/patch-app-module.js /tmp/patch-app-module.js
RUN node /tmp/patch-app-module.js && rm /tmp/patch-app-module.js

# ===================== Pivot Table: Frontend Injection =====================
COPY pivot-table/inject.js /app/pivot-table/inject.js
COPY pivot-table/inject.css /app/pivot-table/inject.css

# ===================== Workflow Packages: Build bundle at image build time =====================
COPY workflow-packages/build.js /tmp/build-workflow-packages.js
RUN cd /app/server && node /tmp/build-workflow-packages.js && \
    rm /tmp/build-workflow-packages.js && \
    rm -rf /tmp/.npm /tmp/wf-pkg-build

COPY workflow-packages/patch-bundle-service.js /tmp/patch-bundle-service.js
RUN node /tmp/patch-bundle-service.js && rm /tmp/patch-bundle-service.js

# ===================== Permissions =====================
RUN chown -R appuser:0 /app/server/dist/ee/licensing/configs/License.js && \
    chown -R appuser:0 /app/server/dist/src/modules/licensing/configs/License.js && \
    chown -R appuser:0 /app/server/dist/src/modules/query-folders/ && \
    chown -R appuser:0 /app/server/dist/ee/query-folders/ && \
    chown -R appuser:0 /app/server/dist/migrations/1760000000000-CreateQueryFolders.js && \
    chown -R appuser:0 /app/server/dist/src/modules/pivot-table-config/ && \
    chown -R appuser:0 /app/server/dist/ee/pivot-table-config/ && \
    chown -R appuser:0 /app/server/dist/migrations/1760100000000-CreatePivotTableConfig.js && \
    chown -R appuser:0 /app/server/dist/migrations/1760200000000-AddComponentIdToPivotConfig.js && \
    chown -R appuser:0 /app/server/dist/migrations/1760300000000-CleanupOrphanedPivotConfigs.js && \
    chown -R appuser:0 /app/query-folders/ && \
    chown -R appuser:0 /app/pivot-table/ && \
    chown -R appuser:0 /app/workflow-packages/

USER appuser

ENTRYPOINT ["/app/query-folders/entrypoint.sh"]
