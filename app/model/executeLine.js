module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    lineId: { type: Number, unique: true },
    lineName: { type: String },
    walletConfig: { type: Array },
    withdrawAddress: { type: String },
    groupId: { type: Number },
    groupSort: { type: Object },
  });

  return mongoose.model("ExecuteLine", schema);
};
