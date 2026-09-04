import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Logger } from "../logger/index.js";
import type { WorkspaceEntryView } from "./oauth.js";

export interface BearerAuthDeps {
  /** Live workspace contexts; the bearer token identifies its owner. */
  entries: () => WorkspaceEntryView[];
  /** Canonical resource string (public URL + /mcp) for resource binding. */
  resource: () => string;
  logger: Logger;
}

/**
 * Bearer-token guard for the host's /mcp endpoint.
 * - missing/invalid/expired token     -> 401 (+ WWW-Authenticate)
 * - token bound to another deployment -> 403 invalid resource
 * On success the owning workspace entry is attached to the request so the
 * route dispatches to that workspace's MCP handler.
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    if (!header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${deps.resource().replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`
        )
        .json({ error: "unauthorized", error_description: "Bearer token required" });
      return;
    }
    const token = header.slice(7).trim();
    for (const entry of deps.entries()) {
      const verdict = entry.store.verifyAccessToken(token);
      if (!verdict.ok) continue;
      const record = verdict.record;
      // Resource binding: a token minted for another deployment is rejected
      // even though the store lookup succeeded.
      if (record.resource && record.resource !== deps.resource()) {
        deps.logger.warn("Rejected MCP request: token resource does not match this host");
        res.status(403).json({
          error: "forbidden",
          error_description: "This token is not valid for this deployment",
        });
        return;
      }
      const authInfo: AuthInfo = {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: Math.floor(record.expiresAt / 1000),
      };
      (req as Request & { auth?: AuthInfo }).auth = authInfo;
      (req as Request & { c2cEntry?: WorkspaceEntryView }).c2cEntry = entry;
      next();
      return;
    }
    deps.logger.warn("Rejected MCP request: token unknown, expired or revoked");
    res.status(401).json({ error: "unauthorized", error_description: "Token unknown" });
  };
}
