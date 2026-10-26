import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
};

export function getClerkUserId(req: Parameters<typeof getAuth>[0]): string {
  const userId = getAuth(req).userId;
  if (!userId) throw new Error("Authentication is required.");
  return userId;
}

export function getAppRole(
  req: Parameters<typeof getAuth>[0],
): "student" | "manager" {
  const claims = getAuth(req).sessionClaims as
    | Record<string, unknown>
    | undefined;
  const metadata =
    claims?.publicMetadata ??
    claims?.public_metadata ??
    claims?.metadata;
  if (!metadata || typeof metadata !== "object") return "student";

  const role = (metadata as Record<string, unknown>).role;
  return role === "manager" ? "manager" : "student";
}
