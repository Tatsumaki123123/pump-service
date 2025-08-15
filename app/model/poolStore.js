module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    token: { type: String, unique: true },
    poolData: { type: Buffer },
    pool: { type: String },
    poolObj: { type: Object },
  });

  return mongoose.model("PoolStore", schema);
};
