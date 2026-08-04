import { readConfig } from "./config";
import { startServer } from "./http";

const config = readConfig();

const server = await startServer(config).catch((err: unknown) => {
  // A startup failure is an operator's problem to solve, and they need the
  // reason on one line rather than a stack ending in a listen callback.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

const scheme = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
console.log(`Lykeion workspace server on ${scheme}://${config.host}:${server.port}`);
console.log(`Records in ${config.dataDir}`);

// Close the database on the way out rather than leaving the write-ahead log
// for the next process to recover.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
