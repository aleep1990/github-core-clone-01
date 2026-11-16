// pkt-line framing (git wire protocol) + side-band multiplexing.
// 4 hex length bytes = payload length + 4; 0000 flush, 0001 delim, 0002 end.
// Max packet 65520 bytes (payload max 65516).

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Split a buffer into pkt-line items. Throws on malformed framing. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      items.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (head === '0002') {
      items.push({ kind: 'end' });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (Number.isNaN(len) || len < 4 || i + len > buf.length) {
      throw new Error('pktline-malformed');
    }
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return items;
}

/**
 * Wrap raw bytes in side-band packets (band 1 = data, 2 = progress, 3 = error).
 * Each packet carries a 1-byte band prefix; payloads chunk to fit 65516.
 */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65516 payload max minus the 1 band byte
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let i = 0; i < data.length; i += CHUNK) {
    const piece = data.subarray(i, i + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  return out;
}

/** Split side-band packets back into per-band byte streams. */
export function demuxSideband(packets: PktItem[]): Map<number, Buffer[]> {
  const bands = new Map<number, Buffer[]>();
  for (const item of packets) {
    if (item.kind !== 'data' || item.data.length === 0) continue;
    const band = item.data[0] as number;
    const list = bands.get(band) ?? [];
    list.push(item.data.subarray(1));
    bands.set(band, list);
  }
  return bands;
}
