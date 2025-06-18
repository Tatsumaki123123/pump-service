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
      const { groupId, sourceWeb = "debot" } = lineData;
      console.log(sourceWeb);
      let allList = [];
      if (sourceWeb === "debot") {
        allList = await ctx.service.debot.getHotToken(
          groupId,
          lineData.groupSort
        );
      } else if (sourceWeb === "ave") {
        //ave
        allList = await ctx.service.ave.getList(lineData.groupSort);
      } else {
        throw new Error("Not source web");
      }

      const buyTokens = await ctx.model.ExecuteToken.find({
        eid: executeData.eid,
        status: { $in: ["buy", "sell"] },
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
      throw new Error("param error");
    }
  }
}
module.exports = ExecuteToken;
