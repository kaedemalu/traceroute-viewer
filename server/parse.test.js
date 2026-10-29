import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceAggregator, parseHeader, parseHopLine } from './parse.js';

test('ヘッダー行から宛先IPを取る（IPv4 / IPv6）', () => {
  assert.deepEqual(
    parseHeader('traceroute to example.com (93.184.216.34), 30 hops max, 60 byte packets'),
    { target: 'example.com', ip: '93.184.216.34' },
  );
  assert.deepEqual(
    parseHeader('traceroute6 to ipv6.google.com (2404:6800:4004:80b::200e) from 2001:db8::1, 64 hops max, 12 byte packets'),
    { target: 'ipv6.google.com', ip: '2404:6800:4004:80b::200e' },
  );
  assert.equal(parseHeader('1  192.168.1.1  1.0 ms'), null);
});

test('通常のホップ行', () => {
  const p = parseHopLine(' 1  192.168.1.1  2.345 ms  1.234 ms  1.111 ms');
  assert.equal(p.ttl, 1);
  assert.equal(p.probes.length, 3);
  assert.deepEqual(p.probes[0], { ip: '192.168.1.1', rtt: 2.345 });
});

test('応答なし行', () => {
  const p = parseHopLine(' 3  * * *');
  assert.equal(p.ttl, 3);
  assert.deepEqual(p.probes, [{ loss: true }, { loss: true }, { loss: true }]);
});

test('先頭が応答なしでも後続のIPを拾う', () => {
  const p = parseHopLine(' 3  * 10.0.0.1  5.2 ms  5.1 ms');
  assert.equal(p.probes.length, 3);
  assert.deepEqual(p.probes[0], { loss: true });
  assert.deepEqual(p.probes[1], { ip: '10.0.0.1', rtt: 5.2 });
});

test('名前解決ありの形式 host (ip)', () => {
  const p = parseHopLine(' 1  _gateway (192.168.1.1)  0.5 ms  0.4 ms  0.3 ms');
  assert.equal(p.probes.length, 3);
  assert.equal(p.probes[0].ip, '192.168.1.1');
});

test('IPv6 のホップ行', () => {
  const p = parseHopLine(' 2  2001:db8::1  10.5 ms  10.1 ms  10.3 ms');
  assert.equal(p.probes.length, 3);
  assert.equal(p.probes[0].ip, '2001:db8::1');
});

test('ECMP: 同じ行に複数IP', () => {
  const agg = new TraceAggregator();
  const snap = agg.ingest(' 5  10.0.0.1  1.0 ms  10.0.0.2  2.0 ms  10.0.0.1  3.0 ms');
  assert.equal(snap.hosts.length, 2);
  const a = snap.hosts.find((h) => h.ip === '10.0.0.1');
  assert.deepEqual(a.rtts, [1, 3]);
  assert.equal(a.avg, 2);
  assert.equal(a.min, 1);
  assert.equal(a.max, 3);
});

test('継続行は直前のホップに合流する', () => {
  const agg = new TraceAggregator();
  agg.ingest(' 6  10.1.1.1  5.0 ms  *  *');
  const snap = agg.ingest('    10.1.1.2  6.0 ms');
  assert.equal(snap.ttl, 6);
  assert.equal(snap.hosts.length, 2);
  assert.equal(snap.lost, 2);
  assert.equal(snap.sent, 4);
});

test('ロス率の元になる sent / lost', () => {
  const agg = new TraceAggregator();
  const snap = agg.ingest(' 7  10.0.0.9  1.0 ms  *  2.0 ms');
  assert.equal(snap.sent, 3);
  assert.equal(snap.lost, 1);
});

test('到達不能の注釈 (!H など)', () => {
  const agg = new TraceAggregator();
  const snap = agg.ingest(' 4  10.0.0.9  0.8 ms !H  0.7 ms !H  0.9 ms !H');
  assert.deepEqual(snap.notes, ['!H']);
  assert.equal(snap.hosts[0].rtts.length, 3);
});

test('ホップ行でない出力は無視する', () => {
  const agg = new TraceAggregator();
  assert.equal(parseHopLine('traceroute: Warning: multiple interfaces found'), null);
  assert.equal(agg.ingest('traceroute: Warning: multiple interfaces found'), null);
  assert.equal(agg.ingest(''), null);
});
