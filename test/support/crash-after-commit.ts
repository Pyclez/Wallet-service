import { bootstrap } from "../../src/bootstrap";
import { loadConfig } from "../../src/config";
import { AFTER_COMMIT_HOOK } from "../../src/tokens";

await bootstrap(loadConfig(), [{ provide: AFTER_COMMIT_HOOK, useValue: () => process.exit(86) }]);
