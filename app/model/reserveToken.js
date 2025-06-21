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
  });

  return mongoose.model("ReserveToken", schema);
};
