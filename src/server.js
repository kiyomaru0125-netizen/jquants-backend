import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jquants, { resetThrottleQueue } from './jquantsClient.js';
import {
  mapToStockShape,
  mapToEpsHistory,
  mapToDividendHistory,
  mapToListedStockShape,
  getLatestSales,
  getSplitCheckStartDate,
  getHistorySplitCheckStartDate,
} from './mapStocks.js';
import { runScreening } from './screening.js';

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

// トップ画面(/api/fundamentals)に並べる人気銘柄のコード一覧。
// 上場廃止になった銘柄はここから外す(残っていても処理は止まらないが、起動時ログに警告が出る)。
//   2024-07 上場廃止: 2651 ローソン / 2025-09 上場廃止: 9613 NTTデータグループ
//   2026-09 J-Quantsの全銘柄一覧に無いため除外: 5017, 5191, 9315
const WATCHED_CODES = [
  '7203', '7267', '7269', '7201', '7261',
  '6758', '6501', '6702', '6752', '6503',
  '9984', '9432', '9433', '9434', '4689',
  '8306', '8316', '8411', '8308', '7182',
  '8058', '8031', '8001', '8002', '8053',
  '3382', '8267', '9983', '3092',
  '4568', '4502', '4523', '4519', '4507',
  '1928', '1925', '1801', '1802', '1803',
  '1332', '1333', '1301', '1379', '1377',
  '1605', '1662', '1518', '1514', '1663',
  '2502', '2503', '2801', '2269', '2802',
  '3401', '3402', '3103', '3110', '3105',
  '3861', '3863', '3864', '3880', '3892',
  '4063', '4901', '4452', '4188', '4005',
  '5019', '5020', '5021', '5013',
  '5108', '5101', '5110', '5105',
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
  '9303', '9364', '8601', '8604',
  '8628', '8616', '8750', '8725', '8766',
  '8630', '8795', '8570', '8572', '8591',
  '8697', '8585', '8801', '8802', '8830',
  '3289', '8804', '4661', '6098', '4324',
  '2432',
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
// メモリ使用量を抑えるため、生のレスポンスをそのまま保存せず、年度決算(FY)のみ・
// 実際に使うフィールドだけに絞って保存する（4,444銘柄分保持し続けるため、
// ここを絞らないとメモリ不足でサーバーが落ちる原因になる）。
const statementsCache = new Map(); // code -> { statements, fetchedAt }
const STATEMENTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間(決算情報は頻繁には変わらないため)

// mapToStockShape・mapToEpsHistory・getLatestSalesが実際に読んでいるフィールドのみ残す
const STATEMENT_FIELDS_TO_KEEP = [
  'CurPerType',
  'DiscDate',
  'CurFYEn',
  'EPS',
  'BPS',
  'Sales',
  'NP', // 純利益(ROA計算用)
  'TA', // 総資産(ROA計算用)
  'OP', // 営業利益(ROIC近似計算用)
  'Eq', // 純資産(ROIC近似計算用)
  'DivAnn',
  'FDivAnn',
  'Div1Q',
  'Div2Q',
  'Div3Q',
  'DivFY',
  'ShOutFY',
  'TrShFY',
];

function compactStatements(records) {
  return records
    .filter((r) => r.CurPerType === 'FY') // 年度決算のみ(四半期の生データは不要)
    .map((r) => {
      const compact = {};
      for (const key of STATEMENT_FIELDS_TO_KEEP) {
        if (r[key] !== undefined) compact[key] = r[key];
      }
      return compact;
    });
}

async function getCachedStatements(code) {
  const cached = statementsCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < STATEMENTS_CACHE_TTL_MS) {
    return cached.statements;
  }
  const res = await jquants.fetchStatements(code);
  const statements = compactStatements(res.data ?? []);
  statementsCache.set(code, { statements, fetchedAt: Date.now() });
  return statements;
}

// 全銘柄分のファンダメンタルズは、HTTPリクエストの応答とは切り離してバックグラウンドで
// 準備しておく（人気銘柄 × レート制限対策の待機時間があるため、リクエスト内で
// 同期的に処理するとタイムアウトの原因になる）。
let fundamentalsCache = { data: [], updatedAt: 0 };

// メモリ使用量を10分おきにログに出す(OOMによる強制再起動が疑わしい場合の診断用)
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(
    `メモリ使用量: rss=${Math.round(mem.rss / 1024 / 1024)}MB heapUsed=${Math.round(
      mem.heapUsed / 1024 / 1024
    )}MB (statementsCache: ${statementsCache.size}件, priceCache: ${priceCache.size}件)`
  );
}, 10 * 60 * 1000);

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

const DAY_MS = 24 * 60 * 60 * 1000;
const toIsoDate = (d) => d.toISOString().slice(0, 10);

/**
 * 直近終値と、指定日以降の株式分割(併合)の一覧を返す。
 *   splitsFrom: 分割を調べ始める日付(YYYY-MM-DD)。決算期末の少し前を渡す。
 *               省略時は直近10日分だけ取得する(終値だけが必要な場合)。
 * 日足の調整係数(AdjFactor)が1以外の日を分割・併合として扱う
 * (例: 1株→2株の分割なら、権利落ち日のAdjFactorが0.5)。
 * キャッシュは「どの日付までさかのぼって分割を調べたか」も覚えておき、
 * それより古い日付を求められた場合だけ取り直す。
 */
/**
 * 株価と分割情報をどこから取るか。銘柄カードは表示のたびに配当推移(連続増配バッジ)も
 * 取りにくるため、最初から配当・EPS推移(最大5年)に必要な範囲までまとめて取っておく。
 * こうすると推移のエンドポイントもキャッシュで応答でき、APIの呼び出し回数が増えない。
 */
function getPriceCheckStartDate(statements) {
  return getHistorySplitCheckStartDate(statements) ?? getSplitCheckStartDate(statements);
}

async function getPriceInfo(code, splitsFrom) {
  const today = new Date();
  const defaultFrom = toIsoDate(new Date(today.getTime() - 10 * DAY_MS));
  // Lightプランで取得できるのは過去5年分のため、それより前は求めない
  const oldestAllowed = toIsoDate(new Date(today.getTime() - (5 * 365 - 7) * DAY_MS));
  let from = splitsFrom && splitsFrom < defaultFrom ? splitsFrom : defaultFrom;
  if (from < oldestAllowed) from = oldestAllowed;

  const cached = priceCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS && cached.coveredFrom <= from) {
    return cached.value; // { price, date, prevClose, splits }
  }

  const data = await jquants.fetchDailyQuotes(code, { from, to: toIsoDate(today) });
  const quotes = data.data ?? [];

  // 売買停止などで終値が空の日を飛ばし、値のある直近の日を採用する
  // 直近2日分の終値を拾う(1つ目が最新の終値、2つ目が前日比に使う前日終値)
  const closes = [];
  for (let i = quotes.length - 1; i >= 0 && closes.length < 2; i--) {
    const raw = quotes[i].C ?? quotes[i].Close;
    const close = Number(raw);
    if (raw != null && raw !== '' && Number.isFinite(close) && close > 0) {
      closes.push({ close, date: quotes[i].Date ?? quotes[i].D ?? null });
    }
  }
  const price = closes[0]?.close ?? null;
  const date = closes[0]?.date ?? null;
  const prevClose = closes[1]?.close ?? null;

  const splits = [];
  for (const q of quotes) {
    const factor = Number(q.AdjFactor ?? q.AdjustmentFactor);
    if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
      splits.push({ date: q.Date ?? q.D, factor });
    }
  }

  const value = { price, date, prevClose, splits };
  priceCache.set(code, { value, fetchedAt: Date.now(), coveredFrom: from });
  return value;
}

// 全銘柄を裏側で少しずつキャッシュし続けるための状態
let isWarmingAllStocks = false;
let warmedCount = 0;
let lastProgressAt = Date.now();
// 銘柄ごとの直近売上高。業界内の売上ランキングを組むために、取得できたものから蓄積していく。
const salesByCode = new Map(); // code -> sales(円)
// スクリーニング(毎日のメール通知)用に、全銘柄の指標とEPS推移を保持する
const screeningRecords = new Map(); // code -> { stock, epsHistory }

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
 * 対象は引数で渡されたコードだけ(人気銘柄は呼び出し側で別途先頭に置くため、ここには含めない)。
 * まだ売上データが十分に集まっていない（1周目など）場合は、優先順位をつけず
 * 自然な順番のまま返す（そもそもランキングが決められないため）。
 */
function buildPrioritizedOrder(codes) {
  if (salesByCode.size === 0) return codes;

  const target = new Set(codes);
  const byIndustry = new Map();
  for (const item of listedStocksCache.data) {
    if (!target.has(item.code)) continue;
    if (!byIndustry.has(item.industry)) byIndustry.set(item.industry, []);
    byIndustry.get(item.industry).push(item.code);
  }

  const priorityCodes = [];
  const picked = new Set();
  for (const industryCodes of byIndustry.values()) {
    const ranked = [...industryCodes].sort(
      (a, b) => (salesByCode.get(b) ?? -Infinity) - (salesByCode.get(a) ?? -Infinity)
    );
    ranked.slice(0, 5).forEach((c) => {
      if (!picked.has(c)) {
        priorityCodes.push(c);
        picked.add(c);
      }
    });
  }

  const rest = codes.filter((c) => !picked.has(c));
  return [...priorityCodes, ...rest];
}

/**
 * 東証全銘柄の取得を1つの継続的な処理としてまとめたもの。
 * 毎周、まず人気の銘柄(WATCHED_CODES)を先に処理し、それが終わった時点で
 * fundamentalsCache(トップ画面用)を更新する(起動から数分でトップ画面が実データになる)。
 * その後、残りの銘柄を続けてキャッシュする。1周目は自然な順番のまま、2周目以降は
 * その時点までに分かった売上高を使って「各業界の売上TOP5」を優先して回す。
 * 全件を1周し終えたら少し待って再度最初から回る（新しいデータへの追従・再キャッシュのため）。
 */
async function warmAllStocksInBackground() {
  if (isWarmingAllStocks) return;
  isWarmingAllStocks = true;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (listedStocksCache.data.length === 0) {
        // 起動時の全銘柄一覧の取得に失敗していた場合は、ここで取り直す
        // (以前は検索画面が開かれるまで再取得されず、何もキャッシュされないままになっていた)
        try {
          await withHardTimeout(refreshListedStocksInBackground(), 10 * 60 * 1000, 'refreshListedStocks(retry)');
        } catch (err) {
          console.error('全銘柄一覧の再取得に失敗しました:', err.message);
        }
        lastProgressAt = Date.now();
        if (listedStocksCache.data.length === 0) {
          await sleep(60_000);
          lastProgressAt = Date.now();
          continue;
        }
      }

      const allCodes = listedStocksCache.data.map((s) => s.code);
      const listedSet = new Set(allCodes);
      const listedByCode = new Map(listedStocksCache.data.map((s) => [s.code, s]));
      // 上場廃止などで一覧から消えた銘柄は、スクリーニング対象からも外す
      for (const code of screeningRecords.keys()) {
        if (!listedSet.has(code)) screeningRecords.delete(code);
      }
      const watchedSet = new Set(WATCHED_CODES);

      // 人気銘柄のうち、全銘柄一覧に存在するもの(上場廃止などで消えたものは除く)
      const watchedCodes = WATCHED_CODES.filter((c) => listedSet.has(c));
      const missingWatched = WATCHED_CODES.filter((c) => !listedSet.has(c));
      if (missingWatched.length > 0) {
        console.warn(
          `⚠️ 人気銘柄のうち${missingWatched.length}件が全銘柄一覧にありません(上場廃止の可能性): ${missingWatched.join(', ')}`
        );
      }

      const orderedCodes = [
        ...watchedCodes,
        ...buildPrioritizedOrder(allCodes.filter((c) => !watchedSet.has(c))),
      ];

      const watchedResults = [];

      for (let i = 0; i < orderedCodes.length; i++) {
        const code = orderedCodes[i];
        try {
          const statements = await withHardTimeout(getCachedStatements(code), 90_000, `statements:${code}`);
          const priceInfo = await withHardTimeout(
            getPriceInfo(code, getPriceCheckStartDate(statements)),
            90_000,
            `price:${code}`
          );
          warmedCount += 1;
          if (warmedCount % 100 === 0) {
            console.log(`全銘柄キャッシュ進行中: ${warmedCount}/${orderedCodes.length}件`);
          }

          const sales = getLatestSales(statements);
          if (sales !== null) salesByCode.set(code, sales);

          // 全銘柄について表示用の指標を計算し、スクリーニング用に保持する
          const known = listedByCode.get(code);
          const listedInfo = known ? { CoName: known.name, S33Nm: known.industry } : null;
          const stock = mapToStockShape({
            code,
            listedInfo,
            statements,
            latestClose: priceInfo?.price ?? null,
            priceDate: priceInfo?.date ?? null,
            prevClose: priceInfo?.prevClose ?? null,
            splits: priceInfo?.splits ?? [],
          });
          screeningRecords.set(code, {
            stock,
            epsHistory: mapToEpsHistory(statements, 5, priceInfo?.splits ?? []),
          });

          if (watchedSet.has(code)) {
            watchedResults.push(stock);
          }
        } catch (err) {
          console.error(`銘柄 ${code} の取得に失敗しました:`, err.message);
          // 1銘柄の失敗で全体を止めない
        }

        // 成功・失敗にかかわらず、1銘柄の処理が完了したことを記録する(ウォッチドッグ用)
        lastProgressAt = Date.now();

        // 人気銘柄をひと通り処理し終えた時点で、トップ画面用のfundamentalsCacheを更新する。
        // (一部の銘柄の取得に失敗していても、取れた分で更新する)
        if (i === watchedCodes.length - 1 && watchedResults.length > 0) {
          fundamentalsCache = { data: watchedResults, updatedAt: Date.now() };
          console.log(
            `fundamentals更新完了: ${watchedResults.length}/${WATCHED_CODES.length}件 (${new Date().toLocaleString('ja-JP')})`
          );
        }
      }

      console.log(
        `全銘柄キャッシュが1周完了しました。次周は業界別売上TOP5を優先します (${new Date().toLocaleString('ja-JP')})`
      );
      warmedCount = 0;
      // 1周し終えたら少し休んでから再度回る(翌日の新しい株価に追従するため)。
      // この「意図した休憩」を監視役が異常停止と誤解しないよう、小分けにスリープしながら
      // 進捗時刻を更新し続ける。
      const REST_MS = 60 * 60 * 1000; // 1時間
      const REST_CHUNK_MS = 60 * 1000; // 1分刻み
      for (let elapsed = 0; elapsed < REST_MS; elapsed += REST_CHUNK_MS) {
        await sleep(REST_CHUNK_MS);
        lastProgressAt = Date.now();
      }
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
 * EPS・配当の推移を「今の株数基準」にそろえるための分割情報を取得する。
 * 株価の取得に失敗した場合は、推移自体は返せるよう補正なし(空配列)で続行する。
 */
async function getSplitsForHistory(code, statements) {
  try {
    const info = await withHardTimeout(
      getPriceInfo(code, getHistorySplitCheckStartDate(statements)),
      30_000,
      `price:${code}`
    );
    return info?.splits ?? [];
  } catch (err) {
    console.warn(`⚠️ 銘柄 ${code} の分割情報を取得できなかったため、補正なしで返します:`, err.message);
    return [];
  }
}

/**
 * GET /api/eps-history/:code
 * EPS推移グラフ用に、年度決算からEPSの時系列を返す（最大5年分・株式分割補正済み）。
 */
app.get('/api/eps-history/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const statements = await withHardTimeout(getCachedStatements(code), 30_000, `statements:${code}`);
    const splits = await getSplitsForHistory(code, statements);
    const history = mapToEpsHistory(statements, 5, splits);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dividend-history/:code
 * 年間配当(実績)の推移(最大5年分・株式分割補正済み)と、連続増配年数を返す。
 */
app.get('/api/dividend-history/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const statements = await withHardTimeout(getCachedStatements(code), 30_000, `statements:${code}`);
    const splits = await getSplitsForHistory(code, statements);
    const result = mapToDividendHistory(statements, 5, splits);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/price/:code
 * 単一銘柄の直近終値・その日付・前日終値を返す。
 */
app.get('/api/price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { price, date, prevClose } = await withHardTimeout(getPriceInfo(code), 30_000, `price:${code}`);
    res.json({ code, price, date, prevClose });
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
    const priceInfo = await withHardTimeout(
      getPriceInfo(code, getPriceCheckStartDate(statements)),
      30_000,
      `price:${code}`
    );

    const stock = mapToStockShape({
      code,
      listedInfo: knownName ? { CoName: knownName, S33Nm: knownIndustry } : null,
      statements,
      latestClose: priceInfo?.price ?? null,
      priceDate: priceInfo?.date ?? null,
      prevClose: priceInfo?.prevClose ?? null,
      splits: priceInfo?.splits ?? [],
    });

    res.json(stock);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/screen
 * キャッシュ済みの全銘柄を、高配当株の条件(src/screening.js)で判定した結果を返す。
 * 毎日のメール通知(.github/workflows/daily-screening.yml)から呼ばれる。
 * coverage.screened が少ない場合は、サーバー再起動直後でまだ全銘柄を判定できていない。
 */
app.get('/api/screen', (req, res) => {
  try {
    res.json(runScreening(screeningRecords, { totalListed: listedStocksCache.data.length || null }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`J-Quantsバックエンド起動: http://localhost:${PORT}`);
  // 全銘柄一覧を先に取得しておくと、その企業名・業種を再利用できる(問い合わせ回数を減らせる)。
  // その後、全銘柄の継続キャッシュ処理を開始する。1周目は優先順位をつけず自然な順番のまま進み、
  // 2周目以降は各業界の売上TOP5を優先する(buildPrioritizedOrder参照)。
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
