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
      transferSignature: { type: String },
      transferBlockhash: { type: String },
      transferLastValidBlockHeight: { type: Number },
    },
    { toJSON: { getters: true }, toObject: { getters: true } },
  );

  ExecuteDataSchema.index({ createTime: 1, eid: 1 });

  return mongoose.model("ExecuteData", ExecuteDataSchema);
};
