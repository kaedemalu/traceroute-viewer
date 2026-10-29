// ホップのスナップショット配列 → React Flow のノード/エッジへの変換。

export const COL_W = 260;
export const ROW_H = 150;

export function rttLevel(ms) {
  if (ms == null) return 'none';
  if (ms < 30) return 'good';
  if (ms < 100) return 'ok';
  if (ms < 200) return 'warn';
  return 'bad';
}

export const levelColor = (level) => `var(--lvl-${level})`;

export function ipKind(ip) {
  if (!ip) return null;
  if (/^127\./.test(ip) || ip === '::1') return 'loopback';
  if (/^169\.254\./.test(ip)) return 'linklocal';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 'private';
  const cgnat = /^100\.(\d+)\./.exec(ip);
  if (cgnat && +cgnat[1] >= 64 && +cgnat[1] <= 127) return 'cgnat';
  if (/^fe80:/i.test(ip)) return 'linklocal';
  if (/^f[cd]/i.test(ip)) return 'private';
  return null;
}

export const KIND_LABEL = {
  private: 'プライベート',
  cgnat: 'CGNAT',
  linklocal: 'リンクローカル',
  loopback: 'ループバック',
};

const round1 = (n) => Math.round(n * 10) / 10;

export function buildGraph({ hops, rdns, resolvedIp, running }) {
  const sorted = [...hops].sort((a, b) => a.ttl - b.ttl);
  const maxAvg = Math.max(1, ...sorted.flatMap((h) => h.hosts.map((x) => x.avg)));

  const nodes = [{ id: 'src', type: 'source', position: { x: 0, y: 0 }, data: {} }];
  const edges = [];
  let prevGroup = [{ id: 'src', avg: null, timeout: false }];

  sorted.forEach((hop, i) => {
    const x = (i + 1) * COL_W;
    const items = hop.hosts.length
      ? hop.hosts.map((h) => ({ ...h, timeout: false }))
      : [{ timeout: true }];
    const lossPct = hop.sent ? Math.round((hop.lost / hop.sent) * 100) : 0;

    const group = items.map((it, k) => {
      const id = it.timeout ? `h-${hop.ttl}-timeout` : `h-${hop.ttl}-${it.ip}`;
      const level = it.timeout ? 'none' : rttLevel(it.avg);

      nodes.push({
        id,
        type: 'hop',
        position: { x, y: (k - (items.length - 1) / 2) * ROW_H },
        data: {
          ttl: hop.ttl,
          timeout: it.timeout,
          ip: it.ip,
          hostname: it.ip ? rdns[it.ip] : null,
          avg: it.avg,
          min: it.min,
          max: it.max,
          probes: it.rtts?.length ?? 0,
          level,
          ratio: it.avg ? it.avg / maxAvg : 0,
          lossPct,
          isDestination: !!resolvedIp && it.ip === resolvedIp,
          kind: ipKind(it.ip),
          notes: hop.notes,
        },
      });
      return { id, avg: it.avg ?? null, level, timeout: it.timeout };
    });

    const isLast = i === sorted.length - 1;
    for (const from of prevGroup) {
      for (const to of group) {
        // 前後とも1ホストのときだけ、RTT の増分を線上に表示する
        const single = prevGroup.length === 1 && group.length === 1;
        const delta =
          single && from.avg != null && to.avg != null ? round1(to.avg - from.avg) : null;

        edges.push({
          id: `e-${from.id}-${to.id}`,
          source: from.id,
          target: to.id,
          animated: running && isLast,
          style: {
            stroke: levelColor(to.level),
            strokeWidth: 2.5,
            strokeDasharray: from.timeout || to.timeout ? '6 5' : undefined,
          },
          label:
            delta != null && Math.abs(delta) >= 1
              ? `${delta > 0 ? '+' : ''}${delta} ms`
              : undefined,
        });
      }
    }
    prevGroup = group;
  });

  return { nodes, edges };
}

export function summarize(hops, resolvedIp) {
  const sorted = [...hops].sort((a, b) => a.ttl - b.ttl);
  const reached =
    !!resolvedIp && sorted.some((h) => h.hosts.some((x) => x.ip === resolvedIp));

  let worst = null;
  let prev = null;
  let finalRtt = null;

  for (const h of sorted) {
    if (!h.hosts.length) continue;
    const avg = Math.min(...h.hosts.map((x) => x.avg));
    if (prev) {
      const delta = round1(avg - prev.avg);
      if (delta > 0 && (!worst || delta > worst.delta)) {
        worst = { from: prev.ttl, to: h.ttl, delta };
      }
    }
    prev = { ttl: h.ttl, avg };
    finalRtt = avg;
  }

  return { hopCount: sorted.length, reached, worst, finalRtt };
}
