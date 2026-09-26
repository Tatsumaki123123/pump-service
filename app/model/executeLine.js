module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    lineId: { type: Number, unique: true },
    lineName: { type: String },
    walletConfig: { type: Array },
    withdrawAddress: { type: String },
    groupId: { type: Number },
    groupSort: { type: Object },
    autoStep: { type: Array },
    sourceWeb: { type: String },
    lineBots: { type: Array },
    tokenIndex: { type: Number },
    autoSwap: { type: Boolean },
    firstWallet: { type: Object },
    needFirstWallet: { type: Boolean, default: false },
    minFollowStates: { type: Number, default: 0 },
    maxBuyTax: { type: Number },
    slippage: { type: Number },
  });

  return mongoose.model("ExecuteLine", schema);
};
