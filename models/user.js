// Load required packages
import mongoose from "mongoose";

// Define our user schema
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "name is required"] },
    email: {
      type: String,
      required: [true, "email is required"],
      unique: true,
      trim: true,
      lowercase: true,
    },
    pendingTasks: { type: [String], default: [] }, // Task _id strings
    dateCreated: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Export the Mongoose model
export default mongoose.model("User", UserSchema);
