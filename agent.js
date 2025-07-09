module.exports = (agent) => {
  agent.messenger.on("egg-ready", () => {
    agent.messenger.sendRandom("initListener");
  });
};
