// The forge's HTTP server: routing only. Grown from the starter's app.ts — the
// /healthz boot probe and the JSON 404 are unchanged; the four surfaces live in
// src/smart.ts (git), src/rest.ts (REST v3), src/graphql.ts (GraphQL v4) and
// src/mcp.ts (MCP). A handler that throws never kills the server: the suite's
// repo-survives-errors check requires the forge to stay up after bad requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { jsonError, sendJson } from './src/http.ts';
import { handleGit } from './src/smart.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw).
 * Fast path: origin-form targets are split on '?' instead of `new URL()`. */
function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  if (url.startsWith('/')) {
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    return path === '' ? '/' : path;
  }
  try {
    return new URL(url, 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** /{owner}/{repo}.git/... — the git smart-HTTP surface. */
function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (isGitPath(path)) {
        if (await handleGit(req, res)) return;
      } else if (path === '/api/graphql' || path.startsWith('/api/graphql/')) {
        if (await handleGraphql(req, res)) return;
      } else if (path === '/mcp' || path.startsWith('/mcp/')) {
        if (await handleMcp(req, res)) return;
      } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (await handleRest(req, res)) return;
      }

      // Everything else, every method: GitHub's 404 body (JSON, never HTML).
      jsonError(res, 404, 'Not Found');
    } catch (err) {
      if (!res.headersSent) {
        jsonError(res, 500, err instanceof Error ? err.message : 'internal error');
      } else {
        try {
          res.end();
        } catch {
          // Already ending; nothing more to do.
        }
      }
    }
  });
}
