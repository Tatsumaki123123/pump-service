"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpAmmAdminSdk = void 0;
const pda_1 = require("./pda");
const util_1 = require("./util");
class PumpAmmAdminSdk {
    program;
    globalConfig;
    constructor(connection, programId = pda_1.PUMP_AMM_PROGRAM_ID) {
        this.program = (0, util_1.getPumpAmmProgram)(connection, programId);
        this.globalConfig = (0, pda_1.globalConfigPda)(this.program.programId)[0];
    }
    programId() {
        return this.program.programId;
    }
    fetchGlobalConfigAccount() {
        return this.program.account.globalConfig.fetch(this.globalConfig);
    }
    createConfig(lpFeeBasisPoints, protocolFeeBasisPoints, protocolFeeRecipients, admin) {
        return this.program.methods
            .createConfig(lpFeeBasisPoints, protocolFeeBasisPoints, protocolFeeRecipients)
            .accountsPartial({
            admin,
        })
            .instruction();
    }
    disable(disableCreatePool, disableDeposit, disableWithdraw, disableBuy, disableSell, admin) {
        return this.program.methods
            .disable(disableCreatePool, disableDeposit, disableWithdraw, disableBuy, disableSell)
            .accountsPartial({
            admin,
            globalConfig: this.globalConfig,
        })
            .instruction();
    }
    updateAdmin(admin, newAdmin) {
        return this.program.methods
            .updateAdmin()
            .accountsPartial({
            admin,
            newAdmin,
            globalConfig: this.globalConfig,
        })
            .instruction();
    }
    updateFeeConfig(lpFeeBasisPoints, protocolFeeBasisPoints, protocolFeeRecipients, admin) {
        return this.program.methods
            .updateFeeConfig(lpFeeBasisPoints, protocolFeeBasisPoints, protocolFeeRecipients)
            .accountsPartial({
            admin,
            globalConfig: this.globalConfig,
        })
            .instruction();
    }
}
exports.PumpAmmAdminSdk = PumpAmmAdminSdk;
