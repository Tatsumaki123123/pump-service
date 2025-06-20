module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const WalletSchema = new Schema({
    address: { type: String, unique: true },
    privateKey: { type: String },
    eid: { type: Number },
    isActive: { type: Boolean, default: true },
  });

  return mongoose.model("ExecuteWallet", WalletSchema);
};
