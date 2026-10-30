module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const WalletSchema = new Schema(
    {
      address: { type: String, unique: true },
      privateKey: { type: String },
      walletAddressId: { type: Schema.Types.ObjectId, index: true },
      wid: { type: Number },
      eid: {
        type: Schema.Types.BigInt,
        get: (value) => (value == null ? value : Number(value)),
      },
      isActive: { type: Boolean, default: true },
      createTime: { type: Date },
    },
    { toJSON: { getters: true }, toObject: { getters: true } },
  );

  WalletSchema.index({ eid: 1 });

  return mongoose.model("ExecuteWallet", WalletSchema);
};
