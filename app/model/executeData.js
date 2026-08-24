module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const ExecuteDataSchema = new Schema({
    eid: { type: Number, unique: true },
    bossAddress: { type: String, unique: true },
    privateKey: { type: String },
    active: { type: Boolean, default: false },
    createTime: { type: Date },
    walletsExist: { type: Boolean, default: false },
    line: { type: Number },
  });

  ExecuteDataSchema.index({ createTime: 1, eid: 1 });

  return mongoose.model("ExecuteData", ExecuteDataSchema);
};
