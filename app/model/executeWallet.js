const { types } = require("web3");

module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const WalletSchema = new Schema({
    address: { type: String, unique: true },
    privateKey: { type: String },
    active: { type: Boolean, default: false },
    canTwice: { type: Boolean, default: false },
    buyAmount: { type: Number, default: 0 },
  });

  return mongoose.model("ExecuteWallet", WalletSchema);
};
