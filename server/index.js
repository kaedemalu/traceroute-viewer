import express from 'express';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceAggregator, parseHeader } from './parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3001;
// 任意のホストへ traceroute を実行できるサービスなので、既定ではローカルのみで待ち受ける
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT = 3;
const TRACE_TIMEOUT_MS = 180_000; // 30ホップ × 3プローブ × 2秒 の最悪ケース
const RDNS_TIMEOUT_MS = 2_000;
const HEARTBEAT_MS = 15_000;

// 先頭が英数字であることを保証し、"-" 始まりのオプション注入を防ぐ
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function validateTarget(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (net.isIP(t)) return t;
  if (HOSTNAME_RE.test(t)) return t;
  return null;
}

function buildCommand(target, method) {
  // テスト用: 偽の traceroute を差し込める
  if (process.env.TRACEROUTE_BIN) {
    return { cmd: process.env.TRACEROUTE_BIN, args: [target] };
  }

  const v6 = net.isIPv6(target);
  const args = ['-n', '-q', '3', '-w', '2', '-m', '30'];
  if (method === 'icmp') args.push('-I');

  if (process.platform === 'darwin' && v6) {
    return { cmd: 'traceroute6', args: [...args, target] };
  }
  if (v6) args.push('-6');
  return { cmd: 'traceroute', args: [...args, target] };
}

function missingCommandMessage(cmd) {
  const hint =
    process.platform === 'linux'
      ? 'Debian/Ubuntu: sudo apt install traceroute / RHEL系: sudo dnf install traceroute'
      : 'macOS には標準で入っています。PATH を確認してください';
  return `${cmd} コマンドが見つかりません。${hint}`;
}

async function reverseLookup(ip) {
  let timer;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), RDNS_TIMEOUT_MS);
      }),
    ]);
    return names[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    parts.forEach(onLine);
  });
  stream.on('end', () => {
    if (buf) onLine(buf);
    buf = '';
  });
}

let active = 0;
const app = express();

app.get('/api/trace', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // EventSource は HTTP エラーの中身を読めないので、検証エラーも SSE で返す
  const fail = (message) => {
    send('trace-error', { message });
    res.end();
  };

  const target = validateTarget(req.query.target);
  if (!target) return fail('IPアドレスまたはホスト名の形式が正しくありません。');
  if (active >= MAX_CONCURRENT) {
    return fail('実行中のトレースが多すぎます。少し待ってからやり直してください。');
  }

  const method = req.query.method === 'icmp' ? 'icmp' : 'udp';
  const { cmd, args } = buildCommand(target, method);

  active++;
  send('start', { target, method });

  const agg = new TraceAggregator();
  const seenIps = new Set();
  const stderrTail = [];
  let gotHop = false;
  let resolvedSent = false;
  let finished = false;

  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const killTimer = setTimeout(() => {
    send('trace-error', { message: 'タイムアウトしました（3分）。' });
    child.kill('SIGTERM');
  }, TRACE_TIMEOUT_MS);

  const finish = () => {
    if (finished) return;
    finished = true;
    active--;
    clearInterval(heartbeat);
    clearTimeout(killTimer);
    if (!closed) res.end();
  };

  const onLine = (line, isStderr) => {
    const header = parseHeader(line);
    if (header) {
      if (!resolvedSent) {
        resolvedSent = true;
        send('resolved', header);
      }
      return;
    }

    const snap = agg.ingest(line);
    if (snap) {
      gotHop = true;
      send('hop', snap);
      for (const host of snap.hosts) {
        if (seenIps.has(host.ip)) continue;
        seenIps.add(host.ip);
        reverseLookup(host.ip).then((hostname) => {
          if (hostname) send('rdns', { ip: host.ip, hostname });
        });
      }
      return;
    }

    if (isStderr && line.trim()) {
      stderrTail.push(line.trim());
      if (stderrTail.length > 5) stderrTail.shift();
    }
  };

  readLines(child.stdout, (l) => onLine(l, false));
  readLines(child.stderr, (l) => onLine(l, true));

  child.on('error', (err) => {
    send(
      'trace-error',
      {
        message:
          err.code === 'ENOENT'
            ? missingCommandMessage(cmd)
            : `${cmd} を起動できませんでした: ${err.message}`,
      },
    );
    finish();
  });

  child.on('close', (code) => {
    if (code !== 0 && code !== null && !gotHop) {
      send('trace-error', {
        message: stderrTail.join('\n') || `traceroute が終了コード ${code} で終了しました。`,
      });
    } else {
      send('done', { hops: agg.hops.size });
    }
    finish();
  });

  // クライアントが切断（停止ボタン・タブを閉じる）したらプロセスも止める
  res.on('close', () => {
    closed = true;
    child.kill('SIGTERM');
    finish();
  });
});

const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) app.use(express.static(dist));

app.listen(PORT, HOST, () => {
  console.log(`traceroute API: http://${HOST}:${PORT}`);
});
