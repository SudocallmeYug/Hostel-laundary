import app from "./app";
import { logger } from "./lib/logger";

const port = process.env.PORT ? Number(process.env.PORT) : 5001;


if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
});

function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Gracefully shutting down server...");
  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
  // Force shutdown after 10s if connections won't close
  setTimeout(() => {
    logger.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

