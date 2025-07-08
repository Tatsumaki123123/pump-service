module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    amm: { type: String },
    token: { type: String },
    symbol: { type: String },
    dev: { type: String },
    pool: { type: String, unique: true },
    createTime: { type: Date },
  });

  return mongoose.model("MonitorPumpToken", schema);
};
