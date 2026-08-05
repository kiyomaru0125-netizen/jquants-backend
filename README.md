# 日本株高配当ボード用 J-Quantsバックエンド（雛形・V2対応）

`StockDashboard.jsx` の擬似データを、J-Quants API V2から取得した実データに差し替えるための最小構成のバックエンドです。

**2025年12月にJ-Quants APIはV1からV2へ移行し、V1は2026年6月1日に終了しました。**
このコードはV2（APIキー認証）に対応しています。

## セットアップ

```bash
npm install
cp .env.example .env
# .env を開いて、J-Quantsダッシュボードで発行したAPIキーを設定
npm start
```

起動すると `http://localhost:8787` でAPIが立ち上がります。

### APIキーの取得方法

1. https://jpx-jquants.com/ にログイン
2. ダッシュボードの「APIキー」ページで発行
3. `.env` の `JQUANTS_API_KEY` に貼り付け

## 提供エンドポイント

| エンドポイント | 用途 |
|---|---|
| `GET /api/fundamentals` | 事前登録した162銘柄分のデータ（PER/PBR/EPS/利回り/時価総額など） |
| `GET /api/listed-stocks` | **東証全銘柄**の一覧（コード・企業名・業種のみの軽量データ） |
| `GET /api/stock/:code` | 全銘柄の中から選ばれた1銘柄の詳細を、その場で取得(オンデマンド) |
| `GET /api/eps-history/:code` | 指定銘柄のEPS推移（最大5年分） |
| `GET /api/price/:code` | 指定銘柄の直近終値のみ |
| `GET /health` | 死活監視用 |

## フロントエンド（StockDashboard.jsx）側の差し替えイメージ

```jsx
// 差し替え前: ファイル冒頭のハードコードされた配列
// const MASTER_STOCKS = [ ... ];

// 差し替え後の例
const [masterStocks, setMasterStocks] = useState([]);

useEffect(() => {
  fetch('https://あなたのバックエンドURL/api/fundamentals')
    .then((res) => res.json())
    .then(setMasterStocks)
    .catch((err) => console.error('fundamentals取得失敗', err));
}, []);
```

## 注意点（実装前に確認してください）

1. **証券コードは5桁** J-Quants API V2は5桁の証券コード（例: `7203` → `72030`）を使用します。
   `jquantsClient.js` 内で自動変換していますが、レスポンスの `Code` フィールドも5桁で返る点に注意してください。

2. **フィールド名の検証が必要** `src/mapStocks.js` では `/fins/summary` のフィールド名（`EPS`, `BPS`, `Div1Q`〜`DivFY` 等）を
   V2の公式ドキュメント（https://jpx-jquants.com/ja/spec）に基づいて実装していますが、
   実際に一度APIを叩いてレスポンス構造を確認してください（コンソールに生レスポンスを出力すると確認しやすいです）。

3. **無料プランの遅延** 無料プランはデータが遅延して提供されるため、当日の株価・決算が即座には反映されません。
   「じっくり比較して選ぶ」高配当ボードの用途では問題になりにくいですが、念のため把握しておいてください。

4. **`/api/fundamentals` はバックグラウンドで準備される** 35銘柄分をレート制限を避けながら順番に取得するため、
   起動直後は少し時間がかかります(東証33業種・162銘柄分のため、初回は約10分程度)。`/api/fundamentals` 自体は常に即座に応答し、
   まだ準備できていない場合は空配列を返します。フロントエンド側は空配列の場合デモデータに
   フォールバックする作りになっているため、起動直後にアクセスしても壊れずに動きます。
   30分ごとに自動で再取得されます。

   なお、Renderの無料プランは一定時間アクセスがないとスリープします。スリープ復帰後に
   この10分間の取得が完走する前に再びスリープしてしまうと、データがなかなか揃いません。
   気になる場合は、UptimeRobot等で定期的にアクセスさせてスリープ自体を防ぐか、
   Renderの有料プランへのアップグレードを検討してください。

4. **配当回数(dividendFreq)は推定値** `Div1Q`〜`DivFY` のうち非ゼロの件数から推定しています。
   正確な回数が必要な場合は、決算短信のPDF等で個別に確認してください。

5. **APIキーは絶対にフロントエンドに書かない** `JQUANTS_API_KEY` はこのバックエンド(`.env`または
   Renderの環境変数)だけに置き、Reactのコードやブラウザに露出させないでください。

6. **WATCHED_CODES の管理** 現状は `StockDashboard.jsx` の `MASTER_STOCKS` と同じ35銘柄をハードコードしています。
   検索対象を東証全銘柄に広げたい場合は、J-Quantsの `/equities/master`（コード未指定）で
   全銘柄一覧を取得し、動的にリストを作る方式に変更してください。
