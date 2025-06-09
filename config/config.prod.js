const ethers = require("ethers");
module.exports = (appInfo) => {
  const config = (exports = {});
  config.mongoose = {
    client: {
      url: "mongodb://four:Ay4reRmLhpsLE7sh@172.17.0.2:27017/four",
      // url: "mongodb://127.0.0.1/newlife",
      options: { directConnection: true, retryWrites: true, w: "majority" },
      // mongoose global plugins, expected a function or an array of function and options
      plugins: [],
    },
    agent: true,
  };

  config.logger = {
    dir: "/www/wwwroot/202504/four/manager/logs",
  };

  return {
    ...config,
  };
};
