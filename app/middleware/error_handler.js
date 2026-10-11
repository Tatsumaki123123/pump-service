// app/middleware/error_handler.js
module.exports = () => {
  return function* (next) {
    try {
      yield next;
    } catch (err) {
      console.log(err);
      this.app.emit("error", err, this);
      // Network clients use status -1 (or no status) when a request never
      // receives an HTTP response. Koa only accepts valid HTTP status codes.
      const rawStatus = Number(err.status);
      const status =
        Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
          ? rawStatus
          : 500;
      const error =
        status === 500 && this.app.config.env === "prod"
          ? "Internal Server Error"
          : err.message;
      this.body = { status: status, message: error };
      if (status === 422) {
        this.body.detail = err.errors;
      }
      this.status = status;
    }
  };
};
