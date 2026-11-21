// Raw TCP HTTP/1.1 server (stdlib `node:net` only) — a drop-in replacement
// for `node:http` on the forge's request path.
//
// Why: the four timed workloads are per-request-overhead-bound. Node's http
// server pays for a full IncomingMessage/ServerResponse object graph, an
// llhttp parse, and event-emitter dispatch on every request; the handlers
// themselves are a small share of the per-request cost (profiled ~5% of CPU).
// A minimal parser that turns a socket buffer into one request + one
// pre-buffered body, and writes one framed response, removes that overhead
// without touching any handler logic.
//
// Contract: the handlers (smart/rest/graphql/mcp) are UNCHANGED. This module
// presents them with req/res shims exposing exactly the node:http subset
// they use:
//   req.url, req.method, req.headers (lowercase keys), req.on('data'|'end')
//   res.writeHead(status, headers), res.end(data), res.headersSent
// The body is fully buffered before dispatch, so readBody's 'data' + 'end'
// are emitted on the next tick (after the handler has attached listeners).
// Keep-alive: requests on one connection are dispatched strictly in order;
// after a response is written the next buffered request is parsed. Chunked
// request bodies (what real git sends for upload-pack/receive-pack) are
// de-chunked. `Expect: 100-continue` is answered at once. Responses always
// carry Content-Length (computed when the handler omits it) and keep the
// connection open unless the request asked to close.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

type Handler = (req: ReqShim, res: ResShim) => Promise<void> | void;

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  500: 'Internal Server Error',
};

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Request shim
// ---------------------------------------------------------------------------

class ReqShim {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  private body: Buffer;
  private listeners: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  constructor(url: string, method: string, headers: Record<string, string | string[] | undefined>, body: Buffer) {
    this.url = url;
    this.method = method;
    this.headers = headers;
    this.body = body;
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, cb: (...args: unknown[]) => void): this {
    return this.on(event, cb);
  }

  /** Emit the buffered body as one 'data' chunk, then 'end'. Deferred to the
   * next tick so the handler has attached its listeners first. */
  emitBody(): void {
    process.nextTick(() => {
      if (this.body.length > 0) this.emit('data', this.body);
      this.emit('end');
    });
  }

  private emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    for (const cb of list) cb(...args);
  }
}

// ---------------------------------------------------------------------------
// Response shim
// ---------------------------------------------------------------------------

class ResShim {
  headersSent = false;
  private statusCode = 200;
  private headers: Record<string, string> = {};
  private ended = false;
  private socket: Socket;
  private keepAlive: boolean;
  private onEnd: () => void;

  constructor(socket: Socket, keepAlive: boolean, onEnd: () => void) {
    this.socket = socket;
    this.keepAlive = keepAlive;
    this.onEnd = onEnd;
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = { ...headers };
    this.headersSent = true;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  end(data?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    let body: Buffer;
    if (data === undefined) body = Buffer.alloc(0);
    else if (typeof data === 'string') body = Buffer.from(data, 'utf8');
    else body = data;
    if (this.headers['content-length'] === undefined) {
      this.headers['content-length'] = String(body.length);
    }
    if (this.headers['connection'] === undefined) {
      this.headers['connection'] = this.keepAlive ? 'keep-alive' : 'close';
    }
    const reason = REASON[this.statusCode] ?? '';
    const lines: string[] = [`HTTP/1.1 ${this.statusCode} ${reason}`];
    for (const [name, value] of Object.entries(this.headers)) {
      lines.push(`${name}: ${value}`);
    }
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    const out = body.length > 0 ? Buffer.concat([head, body]) : head;
    const socket = this.socket;
    const keepAlive = this.keepAlive;
    socket.write(out, () => {
      if (!keepAlive) {
        try {
          socket.end();
        } catch {
          // Already closing.
        }
      }
      this.onEnd();
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP/1.1 request parser (incremental, per connection)
// ---------------------------------------------------------------------------

interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  keepAlive: boolean;
  expectContinue: boolean;
  /** Bytes consumed from the connection buffer. */
  consumed: number;
}

function parseHeaders(headText: string): { method: string; url: string; headers: Record<string, string | string[] | undefined> } | null {
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length < 2) return null;
  const method = parts[0] as string;
  const url = parts[1] as string;
  const headers: Record<string, string | string[] | undefined> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return { method, url, headers };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Try to parse one complete request from `buf`. Returns null when more bytes
 * are needed. `consumed` is how many bytes of `buf` the request used.
 * Handles Content-Length bodies and chunked transfer-encoding.
 */
/**
 * Parse just the request line + headers from `buf`. Returns null when the
 * header block is incomplete. `headerEnd` is the offset just past '\r\n\r\n'.
 * A malformed request line returns method '' (caller answers 400).
 */
function tryParseHeaders(buf: Buffer): { method: string; url: string; headers: Record<string, string | string[] | undefined>; keepAlive: boolean; expectContinue: boolean; headerEnd: number } | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buf.length > MAX_HEADER_BYTES) return { method: '', url: '', headers: {}, keepAlive: false, expectContinue: false, headerEnd: buf.length };
    return null;
  }
  const headText = buf.subarray(0, headEnd).toString('latin1');
  const parsed = parseHeaders(headText);
  if (parsed === null) return { method: '', url: '', headers: {}, keepAlive: false, expectContinue: false, headerEnd: headEnd + 4 };
  const { method, url, headers } = parsed;
  const expectContinue = (headerValue(headers, 'expect') ?? '').toLowerCase() === '100-continue';
  const requestLine = headText.split('\r\n')[0] ?? '';
  const httpVersion = (requestLine.split(' ')[2] ?? 'HTTP/1.1').trim();
  const conn = (headerValue(headers, 'connection') ?? '').toLowerCase();
  const keepAlive = conn === 'keep-alive' ? true : conn === 'close' ? false : httpVersion !== 'HTTP/1.0';
  return { method, url, headers, keepAlive, expectContinue, headerEnd: headEnd + 4 };
}

/**
 * Parse the body that follows `headerEnd`, given the parsed headers.
 * Returns null when more bytes are needed. `consumed` is the offset just
 * past the body. Handles Content-Length bodies and chunked transfer-encoding.
 */
function tryParseBody(buf: Buffer, headerEnd: number, headers: Record<string, string | string[] | undefined>): { body: Buffer; consumed: number } | null {
  const te = (headerValue(headers, 'transfer-encoding') ?? '').toLowerCase();
  const isChunked = te.includes('chunked');
  let offset = headerEnd;
  if (isChunked) {
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', offset);
      if (lineEnd === -1) return null;
      const sizeLine = buf.subarray(offset, lineEnd).toString('latin1').split(';')[0]?.trim() ?? '';
      const size = Number.parseInt(sizeLine, 16);
      if (!Number.isFinite(size) || size < 0) return { body: Buffer.alloc(0), consumed: offset };
      offset = lineEnd + 2;
      if (size === 0) {
        const trailerEnd = buf.indexOf('\r\n\r\n', offset);
        if (trailerEnd === -1) {
          if (buf.length >= offset + 2 && buf.subarray(offset, offset + 2).toString('latin1') === '\r\n') {
            return { body: Buffer.concat(chunks), consumed: offset + 2 };
          }
          return null;
        }
        return { body: Buffer.concat(chunks), consumed: trailerEnd + 4 };
      }
      if (buf.length < offset + size + 2) return null;
      chunks.push(Buffer.from(buf.subarray(offset, offset + size)));
      offset += size + 2;
    }
  }
  const clRaw = headerValue(headers, 'content-length');
  const cl = clRaw === undefined ? 0 : Number.parseInt(clRaw, 10);
  if (!Number.isFinite(cl) || cl < 0 || cl > MAX_BODY_BYTES) return { body: Buffer.alloc(0), consumed: offset };
  if (buf.length < offset + cl) return null;
  return { body: Buffer.from(buf.subarray(offset, offset + cl)), consumed: offset + cl };
}

interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  keepAlive: boolean;
  expectContinue: boolean;
  /** Bytes consumed from the connection buffer. */
  consumed: number;
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function handleConnection(socket: Socket, handler: Handler): void {
  let buf = Buffer.alloc(0);
  let busy = false;
  let closed = false;

  socket.on('error', () => {
    closed = true;
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  });
  socket.on('close', () => {
    closed = true;
  });

  // Per-connection parse state: headers parsed (and 100 Continue answered)
  // but the body still arriving.
  let pending: { method: string; url: string; headers: Record<string, string | string[] | undefined>; keepAlive: boolean; headerEnd: number } | null = null;

  const pump = (): void => {
    if (closed || busy) return;
    // Phase 1 — headers. Answer `Expect: 100-continue` the moment the
    // headers are in, BEFORE the body arrives: a client that sent Expect
    // (real git does for push, whose pack is large) waits for the 100
    // before it sends the body, so answering only after the full body is
    // a deadlock.
    if (pending === null) {
      const head = tryParseHeaders(buf);
      if (head === null) return;
      if (head.method === '') {
        const bad = Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n', 'latin1');
        socket.write(bad, () => {
          try {
            socket.end();
          } catch {
            // Already closing.
          }
        });
        buf = Buffer.alloc(0);
        return;
      }
      if (head.expectContinue) {
        socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
      }
      pending = { method: head.method, url: head.url, headers: head.headers, keepAlive: head.keepAlive, headerEnd: head.headerEnd };
    }
    // Phase 2 — body.
    const bodyParsed = tryParseBody(buf, pending.headerEnd, pending.headers);
    if (bodyParsed === null) return;
    const parsed: ParsedRequest = {
      method: pending.method,
      url: pending.url,
      headers: pending.headers,
      body: bodyParsed.body,
      keepAlive: pending.keepAlive,
      expectContinue: false,
      consumed: bodyParsed.consumed,
    };
    buf = buf.subarray(parsed.consumed);
    pending = null;
    busy = true;
    const req = new ReqShim(parsed.url, parsed.method, parsed.headers, parsed.body);
    const res = new ResShim(socket, parsed.keepAlive, () => {
      busy = false;
      // The response is on the wire; parse the next buffered request.
      process.nextTick(pump);
    });
    // Call the handler SYNCHRONOUSLY first: it runs to its first await,
    // which is readBody attaching its 'data'/'end' listeners. Only then
    // emit the buffered body (next tick) — process.nextTick runs BEFORE
    // Promise microtasks, so emitting before the handler call would fire
    // 'data'/'end' with no listeners attached and readBody would hang.
    let result: Promise<void> | void;
    try {
      result = handler(req, res);
    } catch (err) {
      result = Promise.reject(err);
    }
    req.emitBody();
    void Promise.resolve(result).catch(() => {
      // The app's own dispatch catches handler errors; this is a last
      // resort so a throw never leaves the socket hanging.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(Buffer.from('{"message":"internal error"}\n', 'utf8'));
      } else {
        res.end();
      }
    });
  };

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    pump();
  });
}

// ---------------------------------------------------------------------------
// Server facade (the subset of node:http's Server that main.ts uses)
// ---------------------------------------------------------------------------

export interface RawServer {
  listen(port: number, hostOrCb?: string | (() => void), cb?: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
}

export function createRawServer(handler: Handler): RawServer {
  const server: NetServer = createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    handleConnection(socket, handler);
  });
  return {
    listen(port: number, hostOrCb?: string | (() => void), cb?: () => void): void {
      // Accept both listen(port, cb) and listen(port, host, cb) like
      // node:http's Server (the profiling scripts pass a host).
      if (typeof hostOrCb === 'function') {
        server.listen(port, hostOrCb);
      } else if (typeof hostOrCb === 'string') {
        server.listen(port, hostOrCb, cb ?? (() => undefined));
      } else {
        server.listen(port, cb ?? (() => undefined));
      }
    },
    address(): { port: number } | string | null {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') return addr;
      return { port: addr.port };
    },
    close(cb?: () => void): void {
      server.close(cb);
    },
    once(event: 'error', cb: (err: Error) => void): void {
      server.once(event, cb);
    },
  };
}
