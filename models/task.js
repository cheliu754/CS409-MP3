// models/task.js
import mongoose from "mongoose";

const TaskSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "name is required"] },
    description: { type: String, default: "" },
    deadline: { type: Date, required: [true, "deadline is required"] },
    completed: { type: Boolean, default: false },
    // MP 要求：String + 默认 ""
    assignedUser: {
      type: String,
      default: "",
    },
    assignedUserName: { type: String, default: "unassigned" },
    dateCreated: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);

TaskSchema.index({ assignedUser: 1 });
TaskSchema.index({ completed: 1 });
TaskSchema.index({ deadline: 1 });

export default mongoose.model("Task", TaskSchema);
