import { buildApp } from "./app.js";
import { loadLocalEnv, readConfig } from "./config.js";

loadLocalEnv();
const config = readConfig(process.env);
const app = buildApp({ config });

await app.listen({
  host: "127.0.0.1",
  port: config.PORT,
});
