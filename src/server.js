require("dotenv").config();
const app = require("./app");
const { startCleanupJob } = require("./services/cleanup.service");

const port = Number(process.env.PORT || 3000);

startCleanupJob();

app.listen(port, () => {
  console.log(`server running at http://localhost:${port}`);
});
