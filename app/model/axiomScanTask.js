module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const AxiomScanTaskSchema = new Schema({
    taskId: { type: String, required: true, unique: true },
    status: {
      type: String,
      required: true,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    params: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    expireAt: { type: Date, required: true },
  });

  AxiomScanTaskSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

  return mongoose.model("AxiomScanTask", AxiomScanTaskSchema);
};
