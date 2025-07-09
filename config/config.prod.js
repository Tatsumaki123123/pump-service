module.exports = (appInfo) => {
  const config = (exports = {});
  config.mongoose = {
    client: {
      url: "mongodb://pumpservice:88DH3BHKKWiy23Hm@172.17.0.2:27017/pumpservice",
      // url: "mongodb://127.0.0.1/newlife",
      options: { directConnection: true, retryWrites: true, w: "majority" },
      // mongoose global plugins, expected a function or an array of function and options
      plugins: [],
    },
    agent: true,
  };

  config.logger = {
    dir: "/www/wwwroot/pump-service/logs",
  };

  return {
    ...config,
  };
};
