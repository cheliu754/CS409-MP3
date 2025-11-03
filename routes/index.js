import homeRouter from "./home.js";
import usersRouter from "./users.js";
import tasksRouter from "./tasks.js";

/*
 * Connect all of your endpoints together here.
 */
export default function (app) {
  app.use("/api", homeRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/tasks", tasksRouter);
}
