module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      exchange: { type: String, required: true, unique: true },
      // 已成功入库的小时，格式 YYYY-MM-DD-HH
      hours: { type: [String], default: [] },
      lastRunAt: { type: Date },
      lastError: { type: String },
      lastErrorAt: { type: Date },
      stats: { type: Object, default: {} },
    },
    { versionKey: false },
  );

  return mongoose.model("PfdCoverage", schema);
};
