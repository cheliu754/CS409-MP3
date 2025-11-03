import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  const connectionString = process.env.TOKEN;
  res.json({ message: `My connection string is ${connectionString}` });
});

export default router;
