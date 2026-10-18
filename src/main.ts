import { bootstrap } from "./bootstrap";
import { loadConfig } from "./config";

await bootstrap(loadConfig());
