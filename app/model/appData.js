module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const AppDataSchema = new Schema({
    X_AUTH: { type: String },
    currentExecuteId: { type: Number, default: 10000 },
    debotCookie: { type: String },
    visitPass: { type: String },
    key: { type: String, default: "basketball" },
    receiveAddress: { type: String },
    receivePrivateKey: { type: String, select: false },
  });

  return mongoose.model("AppData", AppDataSchema);
};
