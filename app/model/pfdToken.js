module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      exchange: { type: String, required: true },
      token: { type: String, required: true },
      symbol: { type: String },
      name: { type: String },
      uri: { type: String },
      creator: { type: String },
      // 创建时间（毫秒）
      createAt: { type: Number, default: 0 },
      // 供应量（已还原成「枚」，不是 raw 整数）
      supply: { type: Number, default: 0 },
      // 毕业时间（毫秒），null 表示还在内盘
      graduatedAt: { type: Number, default: null },
      // 最后一笔 swap 时间（毫秒）
      lastAt: { type: Number, default: 0 },
      // 计价单位的价格：quoteKind=sol 时是 SOL/枚，=usd 时是 USD/枚
      priceQuote: { type: Number, default: 0 },
      quoteMint: { type: String },
      quoteKind: { type: String, default: "sol" },
      // 市值，单位跟随 quoteKind
      mcapQuote: { type: Number, default: 0 },
      // 归一化的美元市值（入库时按当时 SOL 价格折算），仅用于跨计价单位排序
      mcapUsd: { type: Number, default: 0 },
      // 从 metadata uri 懒解析出来的图片，仅用于前端展示
      icon: { type: String },
      updatedAt: { type: Date },
    },
    { versionKey: false },
  );

  schema.index({ exchange: 1, token: 1 }, { unique: true });
  // 主查询：exchange + quoteKind(sol) + 是否毕业 + 创建时间窗 + 市值窗
  schema.index({
    exchange: 1,
    quoteKind: 1,
    graduatedAt: 1,
    createAt: 1,
    mcapQuote: 1,
  });
  schema.index({ exchange: 1, quoteKind: 1, graduatedAt: 1, mcapQuote: 1 });
  schema.index({ exchange: 1, quoteKind: 1, mcapUsd: -1 });
  schema.index({ exchange: 1, createAt: 1 });

  return mongoose.model("PfdToken", schema);
};
