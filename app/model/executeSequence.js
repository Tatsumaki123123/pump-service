module.exports = (app) => {
  const mongoose = app.mongoose;
  const Schema = mongoose.Schema;

  const schema = new Schema(
    {
      _id: { type: String },
      value: {
        type: Schema.Types.BigInt,
        get: (value) => (value == null ? value : Number(value)),
      },
    },
    {
      versionKey: false,
      toJSON: { getters: true },
      toObject: { getters: true },
    },
  );

  return mongoose.model("ExecuteSequence", schema);
};
