module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    tid: { type: Number },
    token: { type: String },
    symbol: { type: String },
    dev: { type: String },
    pool: { type: String },
    createTime: { type: Date },
    income: { type: Number, default: 0 },
    eid: { type: Number },
    line: { type: Number },
    status: { type: String }, // pending, buy, sell
    buyStatus: { type: String, default: "" }, // pending, buy, sell
    buyStartTime: { type: Date },
  });

  return mongoose.model("ExecuteToken", schema);
};
