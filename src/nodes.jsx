import { Handle, Position } from '@xyflow/react';
import { KIND_LABEL } from './graph.js';

const NOTE_TITLE = {
  '!H': 'ホスト到達不可',
  '!N': 'ネットワーク到達不可',
  '!P': 'プロトコル到達不可',
  '!X': '通信が管理上禁止されている',
  '!F': 'フラグメントが必要',
  '!S': '送信元経路の失敗',
};

const fmt = (n) => (n == null ? '–' : n.toFixed(1));

export function SourceNode() {
  return (
    <div className="source">
      <strong>あなた</strong>
      <small>起点</small>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}

export function HopNode({ data: d }) {
  const cls = [
    'hop',
    `hop--${d.level}`,
    d.timeout && 'hop--timeout',
    d.isDestination && 'hop--dest',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} className="handle" />

      <div className="hop__head">
        <span className="hop__ttl">#{d.ttl}</span>
        {d.isDestination && <span className="pill pill--dest">宛先</span>}
        {d.kind && <span className="pill">{KIND_LABEL[d.kind]}</span>}
        {d.notes?.map((n) => (
          <span key={n} className="pill pill--warn" title={NOTE_TITLE[n] ?? n}>
            {n}
          </span>
        ))}
      </div>

      {d.timeout ? (
        <div className="hop__timeout">
          応答なし
          <small>* * *</small>
        </div>
      ) : (
        <>
          <div className="hop__ip" title={d.ip}>
            {d.ip}
          </div>
          <div className="hop__host" title={d.hostname || ''}>
            {d.hostname || ' '}
          </div>
          <div className="hop__rtt">
            <strong>{fmt(d.avg)}</strong>
            <span> ms</span>
            {d.probes > 1 && (
              <small>
                {fmt(d.min)}–{fmt(d.max)}
              </small>
            )}
          </div>
          <div className="bar">
            <div className="bar__fill" style={{ width: `${Math.max(4, d.ratio * 100)}%` }} />
          </div>
          {d.lossPct > 0 && <div className="hop__loss">ロス {d.lossPct}%</div>}
        </>
      )}

      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}
