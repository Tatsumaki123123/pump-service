/**
 * @param {Egg.Application} app - egg application
 */
module.exports = (app) => {
  const { router, controller } = app;
  router.get("/", controller.home.index);

  router.post("/v1/execute/start", controller.executeSwap.start);

  router.post(
    "/v1/execute/generateWallets",
    controller.executeSwap.generateWallets
  );

  router.post("/v1/execute/end", controller.executeSwap.end);
  router.post("/v1/execute/buyToken", controller.executeSwap.buyToken);
  router.post("/v1/execute/sellToken", controller.executeSwap.sellToken);
  router.post("/v1/execute/getWallets", controller.executeSwap.getWallets);
  router.post("/v1/execute/getBoss", controller.executeSwap.getBoss);
  router.post("/v1/execute/getLines", controller.executeSwap.getLines);
  router.post("/v1/execute/checkToken", controller.executeSwap.checkToken);
  router.post(
    "/v1/execute/closeAllAccounts",
    controller.executeSwap.closeAllAccounts
  );
  router.post("/v1/execute/withdraw", controller.executeSwap.withdraw);
  router.post("/v1/execute/getBuyTokes", controller.executeSwap.getBuyTokes);
  router.post(
    "/v1/execute/getTokenAccounts",
    controller.executeSwap.getTokenAccounts
  );
  router.post("/v1/execute/deleteToken", controller.executeSwap.deleteToken);
  router.post("/v1/execute/autoSwap", controller.executeSwap.autoSwap);
  router.post("/v1/execute/nextWallet", controller.executeSwap.nextWallet);

  router.post("/v1/executetoken/tokenList", controller.executeToken.tokenList);
  router.post(
    "/v1/executetoken/initTokenList",
    controller.executeToken.initTokenList
  );
  router.post("/v1/executetoken/addToken", controller.executeToken.addToken);
};
