import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jquants from './jquantsClient.js';
import { mapToStockShape, mapToEpsHistory } from './mapStocks.js';

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// ダッシュボードで扱う銘柄コード一覧
// （今はStockDashboard.jsxのMASTER_STOCKSと同じ35銘柄を想定。
//  将来的には検索対象を広げる場合、東証上場銘柄一覧APIから動的に取得する形に変更する）
const WATCHED_CODES = [
  '7203', '7267', '7269', '7201', '7261',
  '6758', '6501', '6702', '6752', '6503',
  '9984', '9432', '9433', '9434', '4689',
  '8306', '8316', '8411', '8308', '7182',
  '8058', '8031', '8001', '8002', '8053',
  '3382', '8267', '9983', '3092', '2651',
  '4568', '4502', '4523', '4519', '4507',
];

// 直近の株価キャッシュ（同時に何度もdaily_quotesを叩かないようにする簡易キャッシュ）
const priceCache = new Map(); // code -> { price, fetchedAt }
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

// 全銘柄分のファンダメンタルズは、HTTPリクエストの応答とは切り離してバックグラウンドで
// 準備しておく（35銘柄 × レート制限対策の待機時間があるため、リクエスト内で
// 同期的に処理するとタイムアウトの原因になる）。
let fundamentalsCache = { data: [], updatedAt: 0 };
const FUNDAMENTALS_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとに再取得
let isRefreshingFundamentals = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 銘柄1件ごとの待機時間。無料プランのレート制限（1分あたりのリクエスト数上限）に
// 引っかからないよう、余裕を持たせた間隔にしている。429が出る場合はこの値を増やす。
const REQUEST_INTERVAL_MS = 1200;

async function getLatestClose(code) {
  const cached = priceCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return cached.value; // { price, date }
  }

  // Lightプラン以上では当日分のデータが取得できるため、直近10営業日分の範囲で取得する
  // （Freeプランの12週間遅延制限があった場合は、toを91日前などに戻す必要がある）
  const toDate = new Date();
  const to = toDate.toISOString().slice(0, 10);

  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 10);
  const from = fromDate.toISOString().slice(0, 10);

  const data = await jquants.fetchDailyQuotes(code, { from, to });
  const quotes = data.data ?? [];
  const latest = quotes[quotes.length - 1];
  const price = latest ? Number(latest.C ?? latest.Close) : null;
  const date = latest ? (latest.Date ?? latest.D ?? null) : null;

  const value = { price, date };
  priceCache.set(code, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * 全銘柄分のファンダメンタルズをバックグラウンドで取得し、fundamentalsCacheを更新する。
 * レート制限を避けるため、銘柄ごと・APIごとに間隔を空けて順番に取得する。
 * HTTPリクエストとは無関係に動くので、多少時間がかかってもタイムアウトの心配はない。
 */
async function refreshFundamentalsInBackground() {
  if (isRefreshingFundamentals) return;
  isRefreshingFundamentals = true;

  const results = [];
  for (const code of WATCHED_CODES) {
    try {
      const listedInfoRes = await jquants.fetchListedInfo(code);
      await sleep(REQUEST_INTERVAL_MS);
      const statementsRes = await jquants.fetchStatements(code);
      await sleep(REQUEST_INTERVAL_MS);
      const latestCloseInfo = await getLatestClose(code);
      await sleep(REQUEST_INTERVAL_MS);

      const listedInfo = listedInfoRes.data?.[0] ?? null;
      const statements = statementsRes.data ?? [];

      results.push(
        mapToStockShape({
          code,
          listedInfo,
          statements,
          latestClose: latestCloseInfo?.price ?? null,
          priceDate: latestCloseInfo?.date ?? null,
        })
      );
    } catch (err) {
      console.error(`銘柄 ${code} の取得に失敗しました:`, err.message);
      // 1銘柄の失敗で全体を止めない。失敗した銘柄は前回キャッシュの値を使うか、スキップする。
    }
  }

  if (results.length > 0) {
    fundamentalsCache = { data: results, updatedAt: Date.now() };
    console.log(`fundamentals更新完了: ${results.length}件 (${new Date().toLocaleString('ja-JP')})`);
  }
  isRefreshingFundamentals = false;
}

/**
 * GET /api/fundamentals
 * ダッシュボードのMASTER_STOCKSを丸ごと置き換えるためのエンドポイント。
 * 常にキャッシュ済みのデータを即座に返す（まだ何も取得できていない起動直後は空配列を返す）。
 * フロントエンド側は空配列の場合デモデータにフォールバックする作りになっている。
 */
app.get('/api/fundamentals', (req, res) => {
  res.json(fundamentalsCache.data);

  // キャッシュが古い（または空の）場合は、レスポンスを返した後にバックグラウンドで更新をキック
  if (Date.now() - fundamentalsCache.updatedAt > FUNDAMENTALS_REFRESH_INTERVAL_MS) {
    refreshFundamentalsInBackground();
  }
});

/**
 * GET /api/eps-history/:code
 * EPS推移グラフ用に、年度決算からEPSの時系列を返す（最大10年分）。
 */
app.get('/api/eps-history/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const statementsRes = await jquants.fetchStatements(code);
    const history = mapToEpsHistory(statementsRes.data ?? [], 5);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/price/:code
 * 単一銘柄の直近終値と、それが何営業日分のデータかを返す。
 */
app.get('/api/price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { price, date } = await getLatestClose(code);
    res.json({ code, price, date });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`J-Quantsバックエンド起動: http://localhost:${PORT}`);
  // 起動直後にバックグラウンドでファンダメンタルズの初回取得を開始する
  refreshFundamentalsInBackground();
});
