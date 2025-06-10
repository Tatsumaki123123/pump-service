module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const AppDataSchema = new Schema({
    X_AUTH: { type: String },
  });

  return mongoose.model("AppData", AppDataSchema);
};
