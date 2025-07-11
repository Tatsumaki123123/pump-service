class AppBootHook {
  constructor(app) {
    this.app = app;
  }

  async didReady() {
    console.log("didReady");
    const { app } = this;
    app.messenger.on("initListener", (data) => {
      const ctx = app.createAnonymousContext();
      // ctx.service.pumpAmmMonitor.startMonitor();
      ctx.service.rayLaunchMonitor.startMonitor();
      // await ctx.service.pumpfunMonitor.startMonitor();
      // await ctx.service.autoSwap.start(10000);
    });
  }

  async beforeClose() {
    console.log("beforeClose");

    const { app } = this;
    const ctx = app.createAnonymousContext();
    // await ctx.service.pumpfunMonitor.stopMonitor();
  }
}

module.exports = AppBootHook;
