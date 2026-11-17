module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      tid: { type: Number },
      token: { type: String },
      symbol: { type: String },
      icon: { type: String },
      dev: { type: String },
      pool: { type: String },
      amm: { type: String },
      routeInfo: { type: Schema.Types.Mixed },
      // 计价单位不是 WSOL（USDC / 其它 SPL）时由 checkToken 置为 true，
      // 内盘和外盘的买卖都会改用 Jupiter 聚合器
      useJup: { type: Boolean, default: false },
      quoteMint: { type: String },
      createTime: { type: Date },
      income: { type: Number, default: 0 },
      eid: {
        type: Schema.Types.BigInt,
        get: (value) => (value == null ? value : Number(value)),
      },
      line: { type: Number },
      status: { type: String }, // pending, buy, sell
      buyStatus: { type: String, default: "" }, // pending, buy, sell
      buyStartTime: { type: Date },
    },
    { toJSON: { getters: true }, toObject: { getters: true } },
  );

  return mongoose.model("ExecuteToken", schema);
};
