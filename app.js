class AppBootHook {
  constructor(app) {
    this.app = app;
  }

  async didReady() {
    console.log("didReady");
    const { app } = this;
    const ctx = app.createAnonymousContext();

    // await ctx.service.pumpAmmMonitor.startMonitor();
    // await ctx.service.pumpfunMonitor.startMonitor();
    // await ctx.service.autoSwap.start(10000);
  }

  async beforeClose() {
    console.log("beforeClose");

    const { app } = this;
    const ctx = app.createAnonymousContext();
    // await ctx.service.pumpfunMonitor.stopMonitor();
  }
}

module.exports = AppBootHook;
