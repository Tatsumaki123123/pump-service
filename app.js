class AppBootHook {
  constructor(app) {
    this.app = app;
  }

  async didReady() {
    console.log("didReady");
    const { app } = this;
    const ctx = app.createAnonymousContext();

    ctx.service.pumpMonitor.startMonitor();
  }

  async beforeClose() {
    console.log("beforeClose");

    const { app } = this;
    const ctx = app.createAnonymousContext();
  }
}

module.exports = AppBootHook;
