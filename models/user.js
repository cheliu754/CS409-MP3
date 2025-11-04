// models/user.js
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "name is required"] },
    email: {
      type: String,
      required: [true, "email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "invalid email"],
    },
    // MP 要求：pendingTasks 为 String 数组（任务 _id 的字符串）
    pendingTasks: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) =>
          (arr || []).every((v) => typeof v === "string" && v.length > 0),
        message: "pendingTasks must be array of non-empty strings",
      },
      set: (arr) => [...new Set((arr || []).filter(Boolean))],
    },
    dateCreated: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);

UserSchema.index({ email: 1 }, { unique: true });

export default mongoose.model("User", UserSchema);
