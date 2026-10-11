import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig(process.env);
const app = buildApp({ config });

await app.listen({
  host: "127.0.0.1",
  port: config.PORT,
});
