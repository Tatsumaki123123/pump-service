module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    token: { type: String },
    monitorAddress: { type: String },
    buyAmount: { type: Number },
    createTime: { type: Date },
  });

  return mongoose.model("MonitorToken", schema);
};
