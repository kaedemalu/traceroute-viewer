# Traceroute Flow

IPアドレスやホスト名を入力すると、サーバー側で `traceroute` を実行し、ホップが届くたびに [React Flow](https://reactflow.dev/) へ順次描画するアプリです。

- 各ホップを1ノードで表示（IP / 逆引きホスト名 / RTTの平均・最小〜最大 / ロス率）
- RTTで色分け（<30ms 緑 / <100ms 黄 / <200ms 橙 / ≥200ms 赤）。線上には前ホップからの増分を表示
- 応答なし（`* * *`）は点線ノード、ECMPなど同一TTLで複数IPが返る場合は縦に分岐
- プライベート / CGNAT アドレスにはラベルを付けるので、自宅・社内ネットワークの出口がわかる
- 右上に、ホップ数・末端RTT・最大の増加区間をまとめて表示

## 使い方

必要なもの: Node.js 20 以上、`traceroute` コマンド（macOS は標準搭載 / Debian・Ubuntu は `sudo apt install traceroute`）

```bash
npm install

# 開発（API: 3001, 画面: http://localhost:5173）
npm run dev

# 本番相当（ビルド後、API と画面を http://127.0.0.1:3001 で配信）
npm run build
npm start
```

パーサーのテスト: `npm test`

## 仕組み

```
ブラウザ ──(EventSource)──> GET /api/trace?target=...&method=udp|icmp
                              └ traceroute -n -q 3 -w 2 -m 30 <target> を spawn
                                出力を1行ずつパース → SSE で hop / rdns / done を配信
```

- 逆引きは traceroute に任せず（`-n`）、サーバー側で非同期に行い、解決できたものから `rdns` イベントで後追い更新します。
- 画面の「停止」ボタンやタブを閉じると、サーバー側の traceroute プロセスも終了します。

## 注意

- 任意の宛先へ traceroute を実行できるため、**既定では 127.0.0.1 のみで待ち受け**ます。`HOST=0.0.0.0` で公開する場合は、認証やレート制限を別途用意してください。
- 宛先は IP またはホスト名の形式のみ許可し、シェルを介さず引数配列で実行しています（オプション注入対策）。
- UDP で途中から応答が途切れる場合は、画面右上の選択で ICMP を試してください（環境によっては権限が必要です）。
- 中間ルーターのRTTは、ICMP応答の優先度が低く実際より大きく出ることがあります。末端のRTTも悪化していないかを併せて見てください。

## 環境変数

| 名前 | 既定値 | 内容 |
| --- | --- | --- |
| `PORT` | `3001` | APIサーバーのポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス |
| `TRACEROUTE_BIN` | なし | traceroute の代わりに実行するコマンド（テスト用） |
