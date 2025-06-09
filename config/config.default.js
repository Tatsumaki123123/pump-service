/* eslint valid-jsdoc: "off" */

/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = (appInfo) => {
  /**
   * built-in config
   * @type {Egg.EggAppConfig}
   **/
  const config = (exports = {});

  // use for cookie sign key, should change to your own and keep security
  config.keys = appInfo.name + "_1749457041635_4105";

  // add your middleware config here
  config.middleware = ["errorHandler"];

  config.errorHandler = {
    match: "/v1",
  };

  config.security = {
    csrf: {
      enable: false,
      ignore: (ctx) => {
        if (ctx.request.method === "OPTIONS") return true;
        return false;
      },
    },
  };
  config.cors = {
    origin: "*",
    allowMethods: "GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS",
  };

  config.httpclient = {
    request: { timeout: 1000 * 600 },
  };

  // add your user config here
  const userConfig = {
    // myAppName: 'egg',
  };

  return {
    ...config,
    ...userConfig,
  };
};
