module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    token: { type: String },
    name: { type: String },
    symbol: { type: String },
    uri: { type: String },
    pool: { type: String },
    dev: { type: String },
    createTime: { type: Date },
    updateTime: { type: Date },
    metadata: { type: Object },
  });

  return mongoose.model("PumpToken", schema);
};
