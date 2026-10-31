"use strict";

const { Subscription } = require("egg");

class BossRecovery extends Subscription {
  static get schedule() {
    return {
      interval: "10s",
      type: "worker",
      immediate: true,
    };
  }

  async subscribe() {
    // Egg's timer can fire again while RPC calls from the previous run wait.
    if (this.app.bossRecoveryRunning) return;
    this.app.bossRecoveryRunning = true;
    try {
      await this.ctx.service.bossLifecycle.reconcilePending();
    } finally {
      this.app.bossRecoveryRunning = false;
    }
  }
}

module.exports = BossRecovery;
