module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const ExecuteDataSchema = new Schema(
    {
      eid: {
        type: Schema.Types.BigInt,
        unique: true,
        get: (value) => (value == null ? value : Number(value)),
      },
      bossAddress: { type: String, unique: true },
      privateKey: { type: String },
      active: { type: Boolean, default: false },
      createTime: { type: Date },
      walletsExist: { type: Boolean, default: false },
      line: { type: Number },
      bossStatus: {
        type: String,
        enum: ["awaiting_funds", "pending", "active", "retired", "failed"],
      },
      bossPending: { type: Boolean },
      previousExecuteDataId: { type: Schema.Types.ObjectId },
      activatedAt: { type: Date },
      activationBalanceLamports: { type: Number },
      activationSlot: { type: Number },
      transferSignature: { type: String },
      transferBlockhash: { type: String },
      transferLastValidBlockHeight: { type: Number },
      transferTransaction: { type: String, select: false },
    },
    { toJSON: { getters: true }, toObject: { getters: true } },
  );

  ExecuteDataSchema.index({ createTime: 1, eid: 1 });
  ExecuteDataSchema.index(
    { line: 1 },
    { name: "one_active_boss_per_line", unique: true, partialFilterExpression: { active: true } },
  );
  ExecuteDataSchema.index(
    { line: 1, bossPending: 1 },
    { name: "one_pending_boss_per_line", unique: true, partialFilterExpression: { bossPending: true } },
  );

  return mongoose.model("ExecuteData", ExecuteDataSchema);
};
