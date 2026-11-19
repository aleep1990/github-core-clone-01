// Shared HTTP helpers for the four surfaces: body reading, JSON replies with the
// required headers, and Bearer auth against MAKEFUN_SHOP_TOKEN.
// Deterministic: X-GitHub-Request-Id is a counter, never random.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER, type User } from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

/**
 * Read the whole request body. Event-based, not `for await`: the async
 * iterator costs ~0.15 ms per POST on this runtime (measured 0.204 ms vs
 * 0.053 ms server-side), and POSTs are the push/write/clone hot paths.
 * A premature close resolves with the partial body, as the old iterator did
 * (downstream parsing then answers 400); errors and the size cap reject.
 */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err !== undefined) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        done(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done());
    req.on('error', (err: Error) => done(err));
    req.on('close', () => done());
  });
}

function requestIdHeader(): Record<string, string> {
  return { 'x-github-request-id': store.nextRequestId() };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...requestIdHeader(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  data: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    ...requestIdHeader(),
    ...extraHeaders,
  });
  res.end(data);
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * The Bearer token check. The suite always presents MAKEFUN_SHOP_TOKEN; a
 * request without it is 401. When the env token is set, the Bearer must match
 * it exactly; when unset (local dev), any non-empty Bearer passes.
 */
export function authViewer(req: IncomingMessage): User | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) return null;
  const presented = match[1] as string;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '' && presented !== expected) return null;
  return VIEWER;
}

/** Parse a JSON body; throws on malformed input (caller answers 400). */
export function parseJsonBody(buf: Buffer): unknown {
  return JSON.parse(buf.toString('utf8'));
}

/** Split a URL path into segments, decoding each one. Fast path: the
 * request-target is a path (origin form), so a string split replaces the
 * `new URL()` construction the hot paths used to pay for on every request.
 * An absolute-form target still falls back to URL parsing. */
export function pathSegments(req: IncomingMessage): string[] {
  let path = '/';
  const url = req.url ?? '/';
  if (url.startsWith('/')) {
    const q = url.indexOf('?');
    path = q === -1 ? url : url.slice(0, q);
    if (path === '') path = '/';
  } else {
    try {
      path = new URL(url, 'http://entry').pathname;
    } catch {
      path = '/';
    }
  }
  return path.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  if (q === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(q + 1));
}
