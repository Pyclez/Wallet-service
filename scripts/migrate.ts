import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../src/database/mikro-orm.config";

const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(createOrmConfig());

try {
  const migrator = orm.migrator;

  if (command === "up") {
    const applied = await migrator.up();
    console.log(applied.length ? `Aplicadas: ${applied.map((m) => m.name).join(", ")}` : "Nada a aplicar.");
  } else if (command === "down") {
    const reverted = await migrator.down();
    console.log(reverted.length ? `Revertida: ${reverted.map((m) => m.name).join(", ")}` : "Nada a reverter.");
  } else if (command === "status") {
    const executed = await migrator.getExecuted();
    const pending = await migrator.getPending();
    console.log("Executadas:", executed.map((m) => m.name));
    console.log("Pendentes: ", pending.map((m) => m.name));
  } else {
    console.error(`Comando desconhecido: ${command}. Use up, down ou status.`);
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
