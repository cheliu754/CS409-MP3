// Get the packages we need
import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import setupRoutes from "./routes/index.js";

// Read .env file
dotenv.config();

// Create our Express application
const app = express();
const router = express.Router();

// Use environment defined port or 3000
const port = process.env.PORT || 3000;

// Connect to a MongoDB --> Uncomment this once you have a connection string!!
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
});

// Allow CORS so that backend and frontend could be put on different servers
const allowCrossDomain = (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
  next();
};
app.use(allowCrossDomain);

// Use the body-parser package in our application
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);
app.use(bodyParser.json());

// Use routes as a module (see index.js)
setupRoutes(app, router);

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
