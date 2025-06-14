const { Service } = require("egg");

class ExecuteToken extends Service {
  async initTokenList(line) {
    const { ctx } = this;
  }

  async getTokenList(line) {
    const { ctx } = this;
    const executeData = await ctx.service.executeSwap.getExecuteData(line);
    const lineData = await ctx.model.ExecuteLine.findOne({ lineId: line });
    if (executeData && lineData) {
      const { groupId } = lineData;

      if (groupId) {
        const allList = await ctx.service.debot.getHotToken(groupId);
        const buyTokens = await ctx.model.ExecuteToken.find({
          eid: executeData.eid,
          status: { $in: ["buy", "end"] },
        }).lean();
        const newList = [];
        allList.forEach((item) => {
          const existItem = buyTokens.find(
            (buyToken) =>
              buyToken.token.toLowerCase() === item.token.toLowerCase()
          );
          if (!existItem) {
            newList.push(item);
          }
        });
        console.log(allList.length, newList.length);
        return newList;
      } else {
        throw new Error("Debot group id is need");
      }
    } else {
      throw new Error("param error");
    }
  }
}
module.exports = ExecuteToken;
