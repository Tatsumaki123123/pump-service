module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      _id: { type: String },
      token: { type: String },
      expiresAt: { type: Date },
      owner: { type: String },
      acquiredAt: { type: Date },
      pid: { type: Number },
    },
    { versionKey: false },
  );

  return mongoose.model("ExecuteLineLock", schema);
};
