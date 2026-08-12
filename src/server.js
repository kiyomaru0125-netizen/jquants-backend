import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jquants, { resetThrottleQueue } from './jquantsClient.js';
import { mapToStockShape, mapToEpsHistory, mapToListedStockShape, getLatestSales } from './mapStocks.js';

const app = express();

// 想定外の例外が発生しても、サーバープロセス自体は落とさない(最終防衛線)。
// 個々のエンドポイント・バックグラウンド処理側で拾いきれなかった場合の保険。
process.on('unhandledRejection', (err) => {
  console.error('⚠️ unhandledRejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ uncaughtException:', err);
});

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
// Lightプランは1日1回しか株価が更新されないため、TTLは24時間で十分
const priceCache = new Map(); // code -> { price, fetchedAt }
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

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
const STATEMENTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間(決算情報は頻繁には変わらないため)

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 与えられたpromiseが指定時間内に終わらなければ諦めて、ループを先に進めるためのヘルパー。
 * (内部のfetchタイムアウトが何らかの理由で効かなかった場合の、最後の保険)
 * 諦めた後にもとのpromiseが解決/失敗しても、それは無視する(未処理のrejectionにしない)。
 */
function withHardTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`タイムアウト(${label})`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  }).catch((err) => {
    // 元のpromiseが後から解決/失敗しても静かに無視されるよう、ここで拾っておく
    promise.catch(() => {});
    throw err;
  });
}

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

// 全銘柄を裏側で少しずつキャッシュし続けるための状態
let isWarmingAllStocks = false;
let warmedCount = 0;
let lastProgressAt = Date.now();
// 銘柄ごとの直近売上高。業界内の売上ランキングを組むために、取得できたものから蓄積していく。
const salesByCode = new Map(); // code -> sales(円)

// 監視役: 一定時間(5分)進捗が無ければ、何かがハングしていると判断してキューを強制リセットする。
// これにより、想定していない箇所で通信が固まった場合でも、全体が完全に止まったままにならない。
const WATCHDOG_STALL_MS = 5 * 60 * 1000;
setInterval(() => {
  if (isWarmingAllStocks && Date.now() - lastProgressAt > WATCHDOG_STALL_MS) {
    console.warn(
      `⚠️ ${WATCHDOG_STALL_MS / 60000}分以上進捗が無いため、キューを強制リセットします (${new Date().toLocaleString('ja-JP')})`
    );
    resetThrottleQueue();
    lastProgressAt = Date.now();
  }
}, 60 * 1000);

/**
 * 各業界の売上TOP5を先頭に、残りを後ろに続ける順序を組み立てる。
 * まだ売上データが十分に集まっていない（1周目など）場合は、優先順位をつけず
 * 自然な順番のまま返す（そもそもランキングが決められないため）。
 */
function buildPrioritizedOrder(allCodes) {
  if (salesByCode.size === 0) return allCodes;

  const byIndustry = new Map();
  for (const item of listedStocksCache.data) {
    if (!byIndustry.has(item.industry)) byIndustry.set(item.industry, []);
    byIndustry.get(item.industry).push(item.code);
  }

  const priorityCodes = [];
  const picked = new Set();
  for (const codes of byIndustry.values()) {
    const ranked = [...codes].sort(
      (a, b) => (salesByCode.get(b) ?? -Infinity) - (salesByCode.get(a) ?? -Infinity)
    );
    ranked.slice(0, 5).forEach((c) => {
      if (!picked.has(c)) {
        priorityCodes.push(c);
        picked.add(c);
      }
    });
  }

  const rest = allCodes.filter((c) => !picked.has(c));
  return [...priorityCodes, ...rest];
}

/**
 * 東証全銘柄の取得を1つの継続的な処理としてまとめたもの。
 * 1周目は売上データがまだ無いため自然な順番のまま取得し、2周目以降は
 * その時点までに分かった売上高を使って「各業界の売上TOP5」を先頭に優先して回す。
 * 人気の162銘柄(WATCHED_CODES)分が揃った時点でfundamentalsCache(トップ画面用)を更新し、
 * そのまま止まらず残りの銘柄も引き続きキャッシュしていく。
 * 全件を1周し終えたら少し待って再度最初から回る（新しいデータへの追従・再キャッシュのため）。
 */
async function warmAllStocksInBackground() {
  if (isWarmingAllStocks) return;
  isWarmingAllStocks = true;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const allCodes = listedStocksCache.data.map((s) => s.code);
      if (allCodes.length === 0) {
        await sleep(60_000);
        continue;
      }

      const watchedSet = new Set(WATCHED_CODES);
      const orderedCodes = buildPrioritizedOrder(allCodes);

      const watchedResults = [];

      for (const code of orderedCodes) {
        try {
          const statements = await withHardTimeout(getCachedStatements(code), 90_000, `statements:${code}`);
          const latestCloseInfo = await withHardTimeout(getLatestClose(code), 90_000, `price:${code}`);
          warmedCount += 1;
          if (warmedCount % 100 === 0) {
            console.log(`全銘柄キャッシュ進行中: ${warmedCount}/${orderedCodes.length}件`);
          }

          const sales = getLatestSales(statements);
          if (sales !== null) salesByCode.set(code, sales);

          if (watchedSet.has(code)) {
            const known = listedStocksCache.data.find((s) => s.code === code);
            const listedInfo = known ? { CoName: known.name, S33Nm: known.industry } : null;
            watchedResults.push(
              mapToStockShape({
                code,
                listedInfo,
                statements,
                latestClose: latestCloseInfo?.price ?? null,
                priceDate: latestCloseInfo?.date ?? null,
              })
            );
          }
        } catch (err) {
          console.error(`銘柄 ${code} の取得に失敗しました:`, err.message);
          // 1銘柄の失敗で全体を止めない
        }

        // 成功・失敗にかかわらず、1銘柄の処理が完了したことを記録する(ウォッチドッグ用)
        lastProgressAt = Date.now();

        // 人気162銘柄が全部終わった時点で、トップ画面用のfundamentalsCacheを早期に埋める
        if (watchedResults.length === WATCHED_CODES.length && fundamentalsCache.data.length === 0) {
          fundamentalsCache = { data: watchedResults, updatedAt: Date.now() };
          console.log(`fundamentals更新完了: ${watchedResults.length}件 (${new Date().toLocaleString('ja-JP')})`);
        }
      }

      // 1周し終えたら、その時点の162銘柄分でfundamentalsCacheも最新化しておく
      if (watchedResults.length > 0) {
        fundamentalsCache = { data: watchedResults, updatedAt: Date.now() };
      }

      console.log(
        `全銘柄キャッシュが1周完了しました。次周は業界別売上TOP5を優先します (${new Date().toLocaleString('ja-JP')})`
      );
      warmedCount = 0;
      // 1周し終えたら少し休んでから再度回る(翌日の新しい株価に追従するため)
      await sleep(60 * 60 * 1000); // 1時間
    }
  } finally {
    isWarmingAllStocks = false;
  }
}

/**
 * GET /api/fundamentals
 * ダッシュボードのMASTER_STOCKSを丸ごと置き換えるためのエンドポイント。
 * 常にキャッシュ済みのデータを即座に返す（まだ何も取得できていない起動直後は空配列を返す）。
 * フロントエンド側は空配列の場合デモデータにフォールバックする作りになっている。
 */
app.get('/api/fundamentals', (req, res) => {
  res.json(fundamentalsCache.data);
  // 全銘柄の継続キャッシュ処理(warmAllStocksInBackground)が定期的にfundamentalsCacheも
  // 更新し続けているため、ここで個別に再取得をキックする必要はない。
});

/**
 * GET /api/eps-history/:code
 * EPS推移グラフ用に、年度決算からEPSの時系列を返す（最大10年分）。
 */
app.get('/api/eps-history/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const statements = await withHardTimeout(getCachedStatements(code), 30_000, `statements:${code}`);
    const history = mapToEpsHistory(statements, 5);
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
    const { price, date } = await withHardTimeout(getLatestClose(code), 30_000, `price:${code}`);
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
 * その場で取得する（オンデマンド）。財務情報・株価とも24時間キャッシュされる。
 */
app.get('/api/stock/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // 企業名・業種はフロントエンドがすでに全銘柄一覧(/api/listed-stocks)から
    // 知っているため、クエリパラメータで受け取って再取得を省略する（問い合わせ回数を減らすため）
    const { name: knownName, industry: knownIndustry } = req.query;

    const statements = await withHardTimeout(getCachedStatements(code), 30_000, `statements:${code}`);
    const latestCloseInfo = await withHardTimeout(getLatestClose(code), 30_000, `price:${code}`);

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
  // 全銘柄一覧を先に取得しておくと、その企業名・業種を再利用できる(問い合わせ回数を減らせる)。
  // その後、全銘柄の継続キャッシュ処理を開始する(人気162銘柄を先頭に回すため、
  // トップ画面用のデータも比較的早いタイミングで揃う)。
  // 万一、全銘柄一覧の取得自体が固まってしまった場合でも、10分で見切りをつけて
  // 全銘柄の継続キャッシュ処理を開始する(その場合、企業名・業種の再利用ができないだけで
  // 動作自体は継続できる)。
  withHardTimeout(refreshListedStocksInBackground(), 10 * 60 * 1000, 'refreshListedStocksInBackground')
    .catch((err) => {
      console.error('全銘柄一覧の初回取得がタイムアウトしました:', err.message);
    })
    .finally(() => {
      warmAllStocksInBackground();
    });
});
