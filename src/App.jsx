import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Panel, ReactFlow, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { HopNode, SourceNode } from './nodes.jsx';
import { buildGraph, summarize } from './graph.js';

const nodeTypes = { hop: HopNode, source: SourceNode };

const LEGEND = [
  ['good', '< 30 ms'],
  ['ok', '< 100 ms'],
  ['warn', '< 200 ms'],
  ['bad', '≥ 200 ms'],
];

export default function App() {
  const [target, setTarget] = useState('');
  const [method, setMethod] = useState('udp');
  const [status, setStatus] = useState('idle'); // idle | running | done | stopped | error
  const [hops, setHops] = useState({}); // ttl -> スナップショット
  const [rdns, setRdns] = useState({}); // ip -> ホスト名
  const [resolvedIp, setResolvedIp] = useState(null);
  const [error, setError] = useState(null);

  const esRef = useRef(null);
  const { fitView } = useReactFlow();

  useEffect(() => () => esRef.current?.close(), []);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setStatus((s) => (s === 'running' ? 'stopped' : s));
  }, []);

  const start = useCallback(
    (e) => {
      e.preventDefault();
      const t = target.trim();
      if (!t) return;

      esRef.current?.close();
      setHops({});
      setRdns({});
      setResolvedIp(null);
      setError(null);
      setStatus('running');

      const es = new EventSource(
        `/api/trace?target=${encodeURIComponent(t)}&method=${method}`,
      );
      esRef.current = es;

      const close = () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
      };

      es.addEventListener('resolved', (ev) => setResolvedIp(JSON.parse(ev.data).ip));
      es.addEventListener('hop', (ev) => {
        const hop = JSON.parse(ev.data);
        setHops((prev) => ({ ...prev, [hop.ttl]: hop }));
      });
      es.addEventListener('rdns', (ev) => {
        const { ip, hostname } = JSON.parse(ev.data);
        setRdns((prev) => ({ ...prev, [ip]: hostname }));
      });
      es.addEventListener('done', () => {
        setStatus('done');
        close();
      });
      // ネイティブの "error" と区別するため、サーバーからのエラーは別名で受ける
      es.addEventListener('trace-error', (ev) => {
        setError(JSON.parse(ev.data).message);
        setStatus('error');
        close();
      });
      es.onerror = () => {
        if (esRef.current !== es) return;
        setError('サーバーとの接続が切れました。APIサーバーが起動しているか確認してください。');
        setStatus('error');
        close();
      };
    },
    [target, method],
  );

  const hopList = useMemo(() => Object.values(hops), [hops]);
  const running = status === 'running';

  const { nodes, edges } = useMemo(
    () => buildGraph({ hops: hopList, rdns, resolvedIp, running }),
    [hopList, rdns, resolvedIp, running],
  );
  const summary = useMemo(() => summarize(hopList, resolvedIp), [hopList, resolvedIp]);

  // ホップが増えたら全体が見えるように寄せる
  useEffect(() => {
    const id = setTimeout(() => fitView({ padding: 0.25, maxZoom: 1, duration: 350 }), 60);
    return () => clearTimeout(id);
  }, [hopList.length, status, fitView]);

  const statusText = {
    idle: '',
    running: `トレース中… ${summary.hopCount} ホップ`,
    done: summary.reached
      ? `完了: ${summary.hopCount} ホップで宛先に到達`
      : `完了: 宛先には到達しませんでした（${summary.hopCount} ホップ）`,
    stopped: `停止しました（${summary.hopCount} ホップ）`,
    error: '',
  }[status];

  return (
    <div className="app">
      <header className="topbar">
        <h1>Traceroute Flow</h1>
        <form className="form" onSubmit={start}>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="8.8.8.8 または example.com"
            aria-label="宛先のIPアドレスまたはホスト名"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
          />
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            aria-label="プローブの種類"
            disabled={running}
          >
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
          </select>
          {running ? (
            <button type="button" className="btn btn--stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!target.trim()}>
              Trace
            </button>
          )}
        </form>
        <span className="status" aria-live="polite">
          {statusText}
        </span>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          colorMode="system"
          minZoom={0.15}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />

          {hopList.length > 0 && (
            <Panel position="top-right" className="summary">
              <div>
                <span>ホップ数</span>
                <b>{summary.hopCount}</b>
              </div>
              {summary.finalRtt != null && (
                <div>
                  <span>末端のRTT</span>
                  <b>{summary.finalRtt.toFixed(1)} ms</b>
                </div>
              )}
              {summary.worst && (
                <div>
                  <span>最大の増加</span>
                  <b>
                    #{summary.worst.from}→#{summary.worst.to} +{summary.worst.delta} ms
                  </b>
                </div>
              )}
            </Panel>
          )}

          <Panel position="bottom-left" className="legend">
            {LEGEND.map(([level, label]) => (
              <span key={level}>
                <i style={{ background: `var(--lvl-${level})` }} />
                {label}
              </span>
            ))}
            <span>
              <i className="legend__dash" />
              応答なし
            </span>
          </Panel>
        </ReactFlow>

        {status === 'idle' && (
          <div className="empty">
            IPアドレスまたはホスト名を入力して Trace を押してください
          </div>
        )}
      </div>
    </div>
  );
}
