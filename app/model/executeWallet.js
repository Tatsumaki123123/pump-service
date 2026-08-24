module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const WalletSchema = new Schema({
    address: { type: String, unique: true },
    privateKey: { type: String },
    eid: { type: Number },
    isActive: { type: Boolean, default: true },
    createTime: { type: Date },
  });

  WalletSchema.index({ eid: 1 });

  return mongoose.model("ExecuteWallet", WalletSchema);
};
