import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jquants from './jquantsClient.js';
import { mapToStockShape, mapToEpsHistory, mapToListedStockShape } from './mapStocks.js';

const app = express();
app.set('etag', false); // ブラウザが古いレスポンスを304で使い回さないようにする
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
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
  '1928', '1925', '1801', '1802', '1803',
  '1332', '1333', '1301', '1379', '1377',
  '1605', '1662', '1518', '1514', '1663',
  '2502', '2503', '2801', '2269', '2802',
  '3401', '3402', '3103', '3110', '3105',
  '3861', '3863', '3864', '3880', '3892',
  '4063', '4901', '4452', '4188', '4005',
  '5019', '5020', '5021', '5017', '5013',
  '5108', '5101', '5110', '5105', '5191',
  '5201', '5233', '5232', '5214', '5301',
  '5401', '5406', '5411', '5423', '5471',
  '5713', '5711', '5714', '5801', '5802',
  '5946', '5949', '5991', '5975', '5988',
  '6301', '6367', '6273', '6113', '6103',
  '7733', '7731', '7741', '7762', '7751',
  '7832', '7867', '8113', '7911', '7912',
  '9501', '9502', '9503', '9531', '9532',
  '9020', '9022', '9021', '9042', '9064',
  '9101', '9104', '9107', '9110', '9201',
  '9202', '9204', '9206', '9301', '9302',
  '9303', '9364', '9315', '8601', '8604',
  '8628', '8616', '8750', '8725', '8766',
  '8630', '8795', '8570', '8572', '8591',
  '8697', '8585', '8801', '8802', '8830',
  '3289', '8804', '4661', '6098', '4324',
  '9613', '2432',
];

// 直近の株価キャッシュ（同時に何度もdaily_quotesを叩かないようにする簡易キャッシュ）
const priceCache = new Map(); // code -> { price, fetchedAt }
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

// 全銘柄一覧（コード・企業名・業種のみの軽量データ）のキャッシュ。
// 検索対象を東証全銘柄に広げるためのもので、株価やPER/PBR/EPSは含まない。
// 1日1回程度の頻度で十分なので、TTLは長めに設定している。
let listedStocksCache = { data: [], updatedAt: 0 };
const LISTED_STOCKS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間
let isRefreshingListedStocks = false;

async function refreshListedStocksInBackground() {
  if (isRefreshingListedStocks) return;
  isRefreshingListedStocks = true;
  try {
    const raw = await jquants.fetchAllListedStocks();
    const mapped = raw.map(mapToListedStockShape).filter((s) => s.code);
    listedStocksCache = { data: mapped, updatedAt: Date.now() };
    console.log(`全銘柄一覧の更新完了: ${mapped.length}件 (${new Date().toLocaleString('ja-JP')})`);
  } catch (err) {
    console.error('全銘柄一覧の取得に失敗しました:', err.message);
  } finally {
    isRefreshingListedStocks = false;
  }
}

// 個別銘柄の財務情報（EPS/BPS/配当等）のキャッシュ。
// オンデマンド取得（/api/stock/:code）で毎回叩かないようにするため。
const statementsCache = new Map(); // code -> { statements, fetchedAt }
const STATEMENTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

async function getCachedStatements(code) {
  const cached = statementsCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < STATEMENTS_CACHE_TTL_MS) {
    return cached.statements;
  }
  const res = await jquants.fetchStatements(code);
  const statements = res.data ?? [];
  statementsCache.set(code, { statements, fetchedAt: Date.now() });
  return statements;
}

// 全銘柄分のファンダメンタルズは、HTTPリクエストの応答とは切り離してバックグラウンドで
// 準備しておく（35銘柄 × レート制限対策の待機時間があるため、リクエスト内で
// 同期的に処理するとタイムアウトの原因になる）。
let fundamentalsCache = { data: [], updatedAt: 0 };
const FUNDAMENTALS_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとに再取得
let isRefreshingFundamentals = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 銘柄1件ごとの待機時間。無料プランのレート制限（1分あたりのリクエスト数上限）に
// 引っかからないよう、余裕を持たせた間隔にしている。429が出る場合はこの値を増やす。
const REQUEST_INTERVAL_MS = 1300;

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

/**
 * GET /api/listed-stocks
 * 検索対象を東証全銘柄に広げるための軽量な一覧（コード・企業名・業種のみ）。
 * 株価やPER/PBR/EPSは含まない。常にキャッシュ済みのデータを即座に返す。
 */
app.get('/api/listed-stocks', (req, res) => {
  res.json(listedStocksCache.data);

  if (Date.now() - listedStocksCache.updatedAt > LISTED_STOCKS_REFRESH_INTERVAL_MS) {
    refreshListedStocksInBackground();
  }
});

/**
 * GET /api/stock/:code
 * 全銘柄の中から選ばれた1銘柄について、株価・PER/PBR/EPS/利回りなどを
 * その場で取得する（オンデマンド）。財務情報は1時間、株価は5分キャッシュされる。
 */
app.get('/api/stock/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // 企業名・業種はフロントエンドがすでに全銘柄一覧(/api/listed-stocks)から
    // 知っているため、クエリパラメータで受け取って再取得を省略する（問い合わせ回数を減らすため）
    const { name: knownName, industry: knownIndustry } = req.query;

    const statements = await getCachedStatements(code);
    const latestCloseInfo = await getLatestClose(code);

    const stock = mapToStockShape({
      code,
      listedInfo: knownName ? { CoName: knownName, S33Nm: knownIndustry } : null,
      statements,
      latestClose: latestCloseInfo?.price ?? null,
      priceDate: latestCloseInfo?.date ?? null,
    });

    res.json(stock);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`J-Quantsバックエンド起動: http://localhost:${PORT}`);
  // 起動直後にバックグラウンドで取得を開始する
  refreshFundamentalsInBackground();
  refreshListedStocksInBackground();
});
