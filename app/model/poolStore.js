module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    token: { type: String, unique: true },
    poolData: { type: Buffer },
    pool: { type: String },
  });

  return mongoose.model("PoolStore", schema);
};
