module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    address: { type: String, unique: true },
    symbol: { type: String },
    createTime: { type: Date },
    income: { type: Number },
    eid: { type: Number },
  });

  return mongoose.model("ExecuteToken", schema);
};
