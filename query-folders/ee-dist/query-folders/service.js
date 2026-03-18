"use strict";
// EE wrapper — re-exports from CE module with correct paths
const ce = require("../../src/modules/query-folders/service");
Object.assign(exports, ce);
