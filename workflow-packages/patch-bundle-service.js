#!/usr/bin/env node
/**
 * Patch getBundleForExecution() in ToolJet's bundle-generation.service.js
 * to fallback to a pre-built bundle file when no bundle exists in the DB.
 *
 * This allows offline environments to use npm packages in workflow JS code nodes
 * without needing internet to install packages at runtime.
 */
const fs = require('fs');
const path = '/app/server/dist/ee/workflows/services/bundle-generation.service.js';

if (!fs.existsSync(path)) {
  console.log('[WorkflowPackages] bundle-generation.service.js not found, skipping patch.');
  process.exit(0);
}

let content = fs.readFileSync(path, 'utf-8');

// Check if already patched
if (content.includes('WORKFLOW_PACKAGES_FALLBACK')) {
  console.log('[WorkflowPackages] Already patched, skipping.');
  process.exit(0);
}

// Find and patch getBundleForExecution
const original = `async getBundleForExecution(appVersionId) {
        var _a;
        const bundle = await this.bundleRepository.findOne({
            where: { appVersionId: appVersionId, status: 'ready', language: 'javascript' },
            select: ['bundleBinary'],
        });
        return ((_a = bundle === null || bundle === void 0 ? void 0 : bundle.bundleBinary) === null || _a === void 0 ? void 0 : _a.toString('utf-8')) || null;
    }`;

const patched = `async getBundleForExecution(appVersionId) {
        var _a;
        const bundle = await this.bundleRepository.findOne({
            where: { appVersionId: appVersionId, status: 'ready', language: 'javascript' },
            select: ['bundleBinary'],
        });
        const dbResult = ((_a = bundle === null || bundle === void 0 ? void 0 : bundle.bundleBinary) === null || _a === void 0 ? void 0 : _a.toString('utf-8')) || null;
        if (dbResult) return dbResult;
        // WORKFLOW_PACKAGES_FALLBACK: load pre-built bundle from file system
        const fallbackPath = '/app/workflow-packages/bundle.js';
        try { const fs = require('fs'); if (fs.existsSync(fallbackPath)) return fs.readFileSync(fallbackPath, 'utf-8'); } catch (_) {}
        return null;
    }`;

if (!content.includes(original)) {
  console.error('[WorkflowPackages] Could not find getBundleForExecution to patch. ToolJet version may have changed.');
  process.exit(1);
}

content = content.replace(original, patched);
if (!content.includes('WORKFLOW_PACKAGES_FALLBACK')) {
  console.error('[WorkflowPackages] Patch applied but marker not found in result. Aborting.');
  process.exit(1);
}
fs.writeFileSync(path, content);
console.log('[WorkflowPackages] Patched getBundleForExecution with file-system fallback.');
