"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const LicenseBase_1 = __importDefault(require("../../../src/modules/licensing/configs/LicenseBase"));
const PlanTerms_1 = require("../constants/PlanTerms");
const constants_1 = require("../../../src/modules/licensing/constants");

class License extends LicenseBase_1.default {
    constructor(key, updatedDate) {
        // Set expiry date 100 years from now
        const expiryDate = new Date();
        expiryDate.setFullYear(expiryDate.getFullYear() + 100);
        const expiryString = expiryDate.toISOString().split('T')[0];
        
        // Full Enterprise license with ALL features enabled
        const fullLicenseData = {
            expiry: expiryString,
            apps: constants_1.LICENSE_LIMIT.UNLIMITED,
            workspaces: constants_1.LICENSE_LIMIT.UNLIMITED,
            users: {
                total: constants_1.LICENSE_LIMIT.UNLIMITED,
                editor: constants_1.LICENSE_LIMIT.UNLIMITED,
                viewer: constants_1.LICENSE_LIMIT.UNLIMITED,
                superadmin: constants_1.LICENSE_LIMIT.UNLIMITED,
            },
            database: {
                table: constants_1.LICENSE_LIMIT.UNLIMITED,
            },
            features: {
                // SSO Features
                oidc: true,
                saml: true,
                ldap: true,
                // Audit & Security
                auditLogs: true,
                externalApi: true,
                // Customization
                customStyling: true,
                customThemes: true,
                whiteLabelling: true,
                appWhiteLabelling: true,
                // Development Features
                multiEnvironment: true,
                gitSync: true,
                multiPlayerEdit: true,
                comments: true,
                // Advanced Features
                serverSideGlobalResolve: true,
                ai: true,
            },
            auditLogs: {
                maximumDays: 365,
            },
            workflows: {
                execution_timeout: 3600,
                workspace: {
                    total: constants_1.LICENSE_LIMIT.UNLIMITED,
                    daily_executions: constants_1.LICENSE_LIMIT.UNLIMITED,
                    monthly_executions: constants_1.LICENSE_LIMIT.UNLIMITED,
                },
                instance: {
                    total: constants_1.LICENSE_LIMIT.UNLIMITED,
                    daily_executions: constants_1.LICENSE_LIMIT.UNLIMITED,
                    monthly_executions: constants_1.LICENSE_LIMIT.UNLIMITED,
                },
            },
            ai: {
                apiKey: '',
                enabled: true,
                credits: constants_1.LICENSE_LIMIT.UNLIMITED,
            },
            domains: [],
            type: constants_1.LICENSE_TYPE.ENTERPRISE,
            plan: {
                name: 'Enterprise',
                isFlexible: false,
            },
        };
        
        const startDate = new Date();
        
        // Call parent constructor with full license data
        super(PlanTerms_1.BASIC_PLAN_TERMS, fullLicenseData, updatedDate, startDate, expiryDate, 'Enterprise');
    }
    
    static Instance() {
        return this._instance;
    }
    
    static Reload(key, updatedDate) {
        return (this._instance = new this(key, updatedDate));
    }
}

License._instance = void 0;
exports.default = License;

