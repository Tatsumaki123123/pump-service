module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    token: { type: String },
    symbol: { type: String },
    dev: { type: String },
    pool: { type: String },
    createTime: { type: Date },
    income: { type: Number, default: 0 },
    eid: { type: Number },
    line: { type: Number },
    status: { type: String }, // pending, buy, sell
  });

  return mongoose.model("ExecuteToken", schema);
};
