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

async function getLatestClose(code) {
  const cached = priceCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
    return cached.price;
  }

  // 直近5営業日分を取得して一番新しい終値を使う（休日・データ未確定日の穴埋め）
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 10);
  const from = fromDate.toISOString().slice(0, 10);

  const data = await jquants.fetchDailyQuotes(code, { from, to });
  const quotes = data.data ?? [];
  const latest = quotes[quotes.length - 1];
  const price = latest ? Number(latest.C ?? latest.Close) : null;

  priceCache.set(code, { price, fetchedAt: Date.now() });
  return price;
}

/**
 * GET /api/fundamentals
 * ダッシュボードのMASTER_STOCKSを丸ごと置き換えるためのエンドポイント。
 * 全銘柄分の { listedInfo + statements + 直近終値 } を集めて返す。
 */
app.get('/api/fundamentals', async (req, res) => {
  try {
    const results = await Promise.all(
      WATCHED_CODES.map(async (code) => {
        const [listedInfoRes, statementsRes, latestClose] = await Promise.all([
          jquants.fetchListedInfo(code),
          jquants.fetchStatements(code),
          getLatestClose(code),
        ]);

        const listedInfo = listedInfoRes.data?.[0] ?? null;
        const statements = statementsRes.data ?? [];

        return mapToStockShape({ code, listedInfo, statements, latestClose });
      })
    );

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    const history = mapToEpsHistory(statementsRes.data ?? [], 10);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/price/:code
 * 単一銘柄の直近終値だけを素早く取得したい場合用。
 */
app.get('/api/price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const price = await getLatestClose(code);
    res.json({ code, price });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`J-Quantsバックエンド起動: http://localhost:${PORT}`);
});
