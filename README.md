# 日本株高配当ボード用 J-Quantsバックエンド（雛形）

`StockDashboard.jsx` の擬似データを、J-Quants APIから取得した実データに差し替えるための最小構成のバックエンドです。

## セットアップ

```bash
npm install
cp .env.example .env
# .env を開いて、J-Quantsのメンバーサイトに登録したメールアドレス・パスワードを設定
npm start
```

起動すると `http://localhost:8787` でAPIが立ち上がります。

## 提供エンドポイント

| エンドポイント | 用途 |
|---|---|
| `GET /api/fundamentals` | `MASTER_STOCKS` を丸ごと置き換えるための全銘柄データ（PER/PBR/EPS/利回り/時価総額など） |
| `GET /api/eps-history/:code` | 指定銘柄のEPS推移（最大10年分） |
| `GET /api/price/:code` | 指定銘柄の直近終値のみ |
| `GET /health` | 死活監視用 |

## フロントエンド（StockDashboard.jsx）側の差し替えイメージ

```jsx
// 差し替え前: ファイル冒頭のハードコードされた配列
// const MASTER_STOCKS = [ ... ];

// 差し替え後の例
const [masterStocks, setMasterStocks] = useState([]);

useEffect(() => {
  fetch('http://localhost:8787/api/fundamentals')
    .then((res) => res.json())
    .then(setMasterStocks)
    .catch((err) => console.error('fundamentals取得失敗', err));
}, []);
```

```jsx
// generateEpsHistory(code, eps) の擬似生成を廃止し、実データ取得に差し替え
function useEpsHistory(code) {
  const [data, setData] = useState([]);
  useEffect(() => {
    fetch(`http://localhost:8787/api/eps-history/${code}`)
      .then((res) => res.json())
      .then(setData);
  }, [code]);
  return data;
}
```

## 注意点（実装前に確認してください）

1. **フィールド名の検証が必要**
   `src/mapStocks.js` では `/fins/statements` のフィールド名（`EarningsPerShare` 等）を
   [J-Quants公式ドキュメント](https://jpx.gitbook.io/j-quants-ja/) に基づいて実装していますが、
   契約プランやAPI改訂で変わる場合があるため、実際に一度APIを叩いてレスポンス構造を確認してください。

2. **無料プランの遅延**
   無料プランはデータが遅延して提供されるため、当日の株価・決算が即座には反映されません。
   「じっくり比較して選ぶ」高配当ボードの用途では問題になりにくいですが、念のため把握しておいてください。

3. **配当回数(dividendFreq)は推定値**
   J-Quantsには「年何回」という直接のフィールドがないため、四半期ごとの配当実績フィールドの
   非ゼロ件数から推定しています。正確な回数が必要な場合は、決算短信のPDF等で個別に確認してください。

4. **認証情報は絶対にフロントエンドに書かない**
   `JQUANTS_MAIL` / `JQUANTS_PASSWORD` はこのバックエンド(`.env`)だけに置き、
   Reactのコードやブラウザに露出させないでください。

5. **WATCHED_CODES の管理**
   現状は `StockDashboard.jsx` の `MASTER_STOCKS` と同じ35銘柄をハードコードしています。
   検索対象を東証全銘柄に広げたい場合は、J-Quantsの `/listed/info`（コード未指定）で
   全銘柄一覧を取得し、動的にリストを作る方式に変更してください。
