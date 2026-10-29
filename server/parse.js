// traceroute の出力（macOS / Linux 共通）を1行ずつパースして、ホップ単位に集計する。

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:.]+(?:%[\w.]+)?$/;
const NUM_RE = /^\d+(?:\.\d+)?$/;
const NUM_MS_RE = /^(\d+(?:\.\d+)?)ms$/;
const ANNOT_RE = /^!\S*$/;
const HEADER_RE = /^traceroute6? to (\S+) \(([^)]+)\)/;

const isIp = (s) =>
  IPV4_RE.test(s) || (s.split(':').length > 2 && IPV6_RE.test(s));

const round1 = (n) => Math.round(n * 10) / 10;

/** "traceroute to example.com (93.184.216.34), ..." → { target, ip } */
export function parseHeader(line) {
  const m = HEADER_RE.exec(line.trim());
  return m ? { target: m[1], ip: m[2] } : null;
}

/**
 * ホップ行をパースする。
 * - 先頭が TTL の行 → { ttl, probes, notes }
 * - ECMP などで続く行（TTL なし） → { ttl: null, probes, notes }
 * - ホップ行でなければ null
 * probes は { ip, rtt } または { loss: true } の配列。
 */
export function parseHopLine(line) {
  const m = /^\s*(\d+)\s+(.*)$/.exec(line);
  const body = (m ? m[2] : line).trim();
  if (!body) return null;

  const tokens = body.split(/\s+/);
  const probes = [];
  const notes = [];
  let ip = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === '*') {
      probes.push({ loss: true });
      continue;
    }

    // 名前解決ありの出力: "host (1.2.3.4)"
    const paren = /^\((.+)\)$/.exec(t);
    if (paren && isIp(paren[1])) {
      ip = paren[1];
      continue;
    }

    if (isIp(t)) {
      ip = t;
      continue;
    }

    const inline = NUM_MS_RE.exec(t);
    if (inline) {
      if (ip) probes.push({ ip, rtt: Number(inline[1]) });
      continue;
    }

    if (NUM_RE.test(t) && tokens[i + 1] === 'ms') {
      if (ip) probes.push({ ip, rtt: Number(t) });
      i++;
      continue;
    }

    if (ANNOT_RE.test(t)) notes.push(t);
  }

  if (probes.length === 0) return null;
  return { ttl: m ? Number(m[1]) : null, probes, notes };
}

function snapshot(hop) {
  const hosts = [...hop.hosts.values()].map((h) => {
    const sum = h.rtts.reduce((a, b) => a + b, 0);
    return {
      ip: h.ip,
      rtts: h.rtts,
      avg: round1(sum / h.rtts.length),
      min: round1(Math.min(...h.rtts)),
      max: round1(Math.max(...h.rtts)),
    };
  });
  const answered = hosts.reduce((a, h) => a + h.rtts.length, 0);
  return {
    ttl: hop.ttl,
    hosts,
    lost: hop.lost,
    sent: answered + hop.lost,
    notes: [...hop.notes],
  };
}

/** 行を流し込むたびに、更新されたホップのスナップショットを返す。 */
export class TraceAggregator {
  constructor() {
    this.hops = new Map();
    this.lastTtl = null;
  }

  ingest(line) {
    const parsed = parseHopLine(line);
    if (!parsed) return null;

    const ttl = parsed.ttl ?? this.lastTtl;
    if (ttl == null) return null;
    this.lastTtl = ttl;

    let hop = this.hops.get(ttl);
    if (!hop) {
      hop = { ttl, hosts: new Map(), lost: 0, notes: new Set() };
      this.hops.set(ttl, hop);
    }

    for (const p of parsed.probes) {
      if (p.loss) {
        hop.lost++;
        continue;
      }
      let host = hop.hosts.get(p.ip);
      if (!host) {
        host = { ip: p.ip, rtts: [] };
        hop.hosts.set(p.ip, host);
      }
      host.rtts.push(p.rtt);
    }
    parsed.notes.forEach((n) => hop.notes.add(n));

    return snapshot(hop);
  }
}
