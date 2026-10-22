module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      tid: { type: Number },
      amm: { type: String },
      token: { type: String },
      symbol: { type: String },
      dev: { type: String },
      pool: { type: String },
      createTime: { type: Date },
      income: { type: Number, default: 0 },
      eid: {
        type: Schema.Types.BigInt,
        get: (value) => (value == null ? value : Number(value)),
      },
      line: { type: Number },
      type: { type: String, default: "good" },
    },
    { toJSON: { getters: true }, toObject: { getters: true } },
  );

  return mongoose.model("ReserveToken", schema);
};
