require("dotenv").config();
/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = (appInfo) => {
  /**
   * built-in config
   * @type {Egg.EggAppConfig}
   **/
  const config = (exports = {});
  config.mongoose = {
    client: {
      // url: "mongodb://pumpservice:Ay4reRmLhpsLE7sh@162.0.224.219:27017/pumpservice",
      url: "mongodb://127.0.0.1:27017/pumpservice",

      options: { directConnection: true, retryWrites: true, w: "majority" },
      // mongoose global plugins, expected a function or an array of function and options
      plugins: [],
    },
    agent: true,
  };
  return {
    ...config,
  };
};
