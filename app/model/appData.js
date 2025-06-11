module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const AppDataSchema = new Schema({
    X_AUTH: { type: String },
    currentExecuteId: { type: Number, default: 10000 },
  });

  return mongoose.model("AppData", AppDataSchema);
};
