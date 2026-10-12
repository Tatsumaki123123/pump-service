"use strict";

module.exports = (app) => {
  const { Schema } = app.mongoose;
  const schema = new Schema({
    lineId: { type: Number, required: true },
    address: { type: String, required: true },
    privateKey: { type: String, required: true, select: false },
    createTime: { type: Date, default: Date.now },
  });

  schema.index({ lineId: 1, address: 1 }, { unique: true });
  schema.index({ lineId: 1, createTime: 1 });

  return app.mongoose.model("FomoWallet", schema);
};
