"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var AppModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const getConnection_1 = require("./database/getConnection");
const shut_down_hook_1 = require("./schedulers/shut-down.hook");
const loader_1 = require("./loader");
const utils_helper_1 = require("../../helpers/utils.helper");
const constants_1 = require("./constants");
const module_1 = require("../instance-settings/module");
const module_2 = require("../ability/module");
const module_3 = require("../licensing/module");
const module_4 = require("../configs/module");
const module_5 = require("../organizations/module");
const module_6 = require("../meta/module");
const module_7 = require("../session/module");
const module_8 = require("../encryption/module");
const controller_1 = require("./controller");
const module_9 = require("../profile/module");
const module_10 = require("../smtp/module");
const module_11 = require("../users/module");
const module_12 = require("../files/module");
const module_13 = require("../roles/module");
const module_14 = require("../group-permissions/module");
const module_15 = require("../organization-users/module");
const module_16 = require("../onboarding/module");
const module_17 = require("../app-environments/module");
const module_18 = require("../data-sources/module");
const module_19 = require("../login-configs/module");
const module_20 = require("../auth/module");
const module_21 = require("../organization-themes/module");
const module_22 = require("../setup-organization/module");
const module_23 = require("../folders/module");
const module_24 = require("../white-labelling/module");
const module_25 = require("../email/module");
const module_26 = require("../organization-constants/module");
const module_27 = require("../folder-apps/module");
const module_28 = require("../apps/module");
const module_29 = require("../versions/module");
const module_30 = require("../data-queries/module");
const module_31 = require("../plugins/module");
const module_32 = require("../templates/module");
const module_33 = require("../import-export-resources/module");
const module_34 = require("../tooljet-db/module");
const module_35 = require("../workflows/module");
const module_36 = require("../ai/module");
const module_37 = require("../custom-styles/module");
const module_38 = require("../app-permissions/module");
const module_39 = require("../events/module");
const module_40 = require("../external-apis/module");
const module_41 = require("../git-sync/module");
const module_42 = require("../app-git/module");
const module_43 = require("../organization-payments/module");
const module_44 = require("../CRM/module");
const clear_sso_response_scheduler_1 = require("../auth/schedulers/clear-sso-response.scheduler");
const sample_db_scheduler_1 = require("../data-sources/schedulers/sample-db.scheduler");
const scheduler_1 = require("../session/scheduler");
const scheduler_2 = require("../audit-logs/scheduler");
const module_45 = require("../modules/module");
const module_46 = require("../email-listener/module");
const module_47 = require("../inMemoryCache/module");
const module_qf = require("../query-folders/module");
const helper_1 = require("../tooljet-db/helper");
const tooljet_db_helper_1 = require("../../helpers/tooljet_db.helper");
const typeorm_1 = require("typeorm");
const config_1 = require("@nestjs/config");
const typeorm_2 = require("@nestjs/typeorm");
const module_48 = require("../metrices/module");
const module_49 = require("../app-history/module");
const module_50 = require("../scim/module");
const nestjs_1 = require("@bull-board/nestjs");
const express_1 = require("@bull-board/express");
const basicAuth = require("express-basic-auth");
const scheduler_3 = require("../auth/scheduler");
let AppModule = AppModule_1 = class AppModule {
    constructor(configService, tooljetDbManager) {
        this.configService = configService;
        this.tooljetDbManager = tooljetDbManager;
    }
    static async register(configs) {
        const modules = await loader_1.AppModuleLoader.loadModules(configs);
        const baseImports = [
            await module_2.AbilityModule.forRoot(configs),
            await module_3.LicenseModule.forRoot(configs),
            await module_12.FilesModule.register(configs, true),
            await module_8.EncryptionModule.register(configs),
            await module_1.InstanceSettingsModule.register(configs, true),
            await module_23.FoldersModule.register(configs, true),
            await module_27.FolderAppsModule.register(configs, true),
            await module_10.SMTPModule.register(configs, true),
            await module_13.RolesModule.register(configs, true),
            await module_14.GroupPermissionsModule.register(configs, true),
            await module_4.AppConfigModule.register(configs, true),
            await module_7.SessionModule.register(configs, true),
            await module_6.MetaModule.register(configs, true),
            await module_5.OrganizationsModule.register(configs, true),
            await module_9.ProfileModule.register(configs, true),
            await module_11.UsersModule.register(configs, true),
            await module_15.OrganizationUsersModule.register(configs, true),
            await module_16.OnboardingModule.register(configs, true),
            await module_17.AppEnvironmentsModule.register(configs, true),
            await module_26.OrganizationConstantModule.register(configs, true),
            await module_18.DataSourcesModule.register(configs, true),
            await module_19.LoginConfigsModule.register(configs, true),
            await module_20.AuthModule.register(configs, true),
            await module_21.ThemesModule.register(configs, true),
            await module_22.SetupOrganizationsModule.register(configs, true),
            await module_24.WhiteLabellingModule.register(configs, true),
            await module_25.EmailModule.register(configs),
            await module_28.AppsModule.register(configs, true),
            await module_29.VersionModule.register(configs, true),
            await module_30.DataQueriesModule.register(configs, true),
            await module_31.PluginsModule.register(configs, true),
            await module_33.ImportExportResourcesModule.register(configs, true),
            await module_32.TemplatesModule.register(configs, true),
            await module_34.TooljetDbModule.register(configs, true),
            await module_45.ModulesModule.register(configs, true),
            await module_36.AiModule.register(configs, true),
            await module_37.CustomStylesModule.register(configs, true),
            await module_38.AppPermissionsModule.register(configs, true),
            await module_39.EventsModule.register(configs),
            await module_40.ExternalApiModule.register(configs, true),
            await module_41.GitSyncModule.register(configs, true),
            await module_42.AppGitModule.register(configs, true),
            await module_44.CrmModule.register(configs, true),
            await module_43.OrganizationPaymentModule.register(configs, true),
            await module_46.EmailListenerModule.register(configs),
            await module_47.InMemoryCacheModule.register(configs),
            await module_qf.QueryFoldersModule.register(configs),
            await module_49.AppHistoryModule.register(configs, true),
            await module_50.ScimModule.register(configs, true),
        ];
        const conditionalImports = [];
        if ((0, utils_helper_1.getTooljetEdition)() !== constants_1.TOOLJET_EDITIONS.Cloud) {
            conditionalImports.push(await module_35.WorkflowsModule.register(configs, true));
            conditionalImports.push(nestjs_1.BullBoardModule.forRoot({
                route: '/jobs',
                adapter: express_1.ExpressAdapter,
                middleware: basicAuth({
                    challenge: true,
                    users: { admin: process.env.TOOLJET_QUEUE_DASH_PASSWORD },
                }),
            }));
        }
        if (process.env.ENABLE_METRICS === 'true') {
            conditionalImports.push(module_48.MetricsModule);
        }
        const imports = [...baseImports, ...conditionalImports];
        return {
            module: AppModule_1,
            imports: [...modules, ...imports],
            controllers: [controller_1.AppController],
            providers: [
                shut_down_hook_1.ShutdownHook,
                getConnection_1.GetConnection,
                clear_sso_response_scheduler_1.ClearSSOResponseScheduler,
                sample_db_scheduler_1.SampleDBScheduler,
                scheduler_1.SessionScheduler,
                scheduler_2.AuditLogsClearScheduler,
                scheduler_3.MfaCleanupScheduler,
            ],
        };
    }
    async onModuleInit() {
        console.log(`Version: ${globalThis.TOOLJET_VERSION}`);
        console.log(`Initializing server modules 📡 `);
        const tooljtDbUser = this.configService.get('TOOLJET_DB_USER');
        const statementTimeout = this.configService.get('TOOLJET_DB_STATEMENT_TIMEOUT') || 60000;
        const statementTimeoutInSecs = Number.isNaN(Number(statementTimeout)) ? 60 : Number(statementTimeout) / 1000;
        if ((0, tooljet_db_helper_1.isSQLModeDisabled)()) {
            await (0, helper_1.reconfigurePostgrestWithoutSchemaSync)(this.tooljetDbManager, {
                user: tooljtDbUser,
                enableAggregates: true,
                statementTimeoutInSecs: statementTimeoutInSecs,
            });
        }
        else {
            await (0, helper_1.reconfigurePostgrest)(this.tooljetDbManager, {
                user: tooljtDbUser,
                enableAggregates: true,
                statementTimeoutInSecs: statementTimeoutInSecs,
            });
        }
        await this.tooljetDbManager.query("NOTIFY pgrst, 'reload schema'");
    }
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = AppModule_1 = __decorate([
    __param(1, (0, typeorm_2.InjectEntityManager)('tooljetDb')),
    __metadata("design:paramtypes", [config_1.ConfigService,
        typeorm_1.EntityManager])
], AppModule);
//# sourceMappingURL=module.js.map
