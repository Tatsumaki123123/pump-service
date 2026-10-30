module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema({
    address: { type: String, unique: true, required: true },
    privateKey: { type: String, required: true },
    status: {
      type: String,
      enum: ["unused", "in_use", "ended"],
      default: "unused",
      index: true,
    },
    createTime: { type: Date, default: Date.now },
    useEid: {
      type: Schema.Types.BigInt,
      get: (value) => (value == null ? value : Number(value)),
    },
    useLine: { type: Number },
    useTime: { type: Date },
    endTime: { type: Date },
  });

  schema.index({ status: 1, createTime: -1 });

  return mongoose.model("ExecuteWalletAddress", schema);
};
