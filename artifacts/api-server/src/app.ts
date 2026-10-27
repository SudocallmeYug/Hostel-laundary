import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Public unauthenticated health check
app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Clerk authentication middleware for API routes
app.use(
  "/api",
  (req, res, next) => {
    if (!process.env.CLERK_SECRET_KEY && !process.env.CLERK_PUBLISHABLE_KEY) {
      return next();
    }
    return clerkMiddleware((r) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(r) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    }))(req, res, next);
  },
);

app.use("/api", router);


// Serve frontend in production or when client build exists
import path from "node:path";
import fs from "node:fs";

const clientDistPath = path.resolve(__dirname, "../../hostel-laundry/dist/public");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/__clerk")) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}


export default app;

