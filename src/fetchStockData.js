// 1銘柄分の決算・株価データをJ-Quants APIから取得する処理。
// server.js(常時稼働のRenderサーバー)と、GitHub Actionsで1回だけ実行するバッチ
// スクリーニングスクリプト(scripts/run_screening_crawl.mjs)の両方から使う。
// キャッシュはこの層では持たない(呼び出し側がそれぞれの事情に合わせて持つ)。

import jquants from './jquantsClient.js';

// mapToStockShape・mapToEpsHistory・getLatestSalesが実際に読んでいるフィールドのみ残す
// (生のレスポンスをそのまま保持すると、全銘柄分(約4,400銘柄)ではメモリを圧迫するため)
export const STATEMENT_FIELDS_TO_KEEP = [
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
  'CA', // 流動資産(流動比率計算用。実レスポンスに含まれるか未確認)
  'CL', // 流動負債(流動比率計算用。実レスポンスに含まれるか未確認)
  'DivAnn',
  'FDivAnn',
  'Div1Q',
  'Div2Q',
  'Div3Q',
  'DivFY',
  'ShOutFY',
  'TrShFY',
];

export function compactStatements(records) {
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

/** 財務情報サマリーを取得し、不要なフィールドを削ったものを返す(キャッシュなし) */
export async function fetchCompactStatements(code) {
  const res = await jquants.fetchStatements(code);
  return compactStatements(res.data ?? []);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const toIsoDate = (d) => d.toISOString().slice(0, 10);

/**
 * 株価を取り始める日付(YYYY-MM-DD)を決める。
 *   splitsFrom: 分割を調べ始めたい日付。省略時は直近10日分だけ取得する。
 * Lightプランで取得できるのは過去5年分のため、それより前は求めない。
 * キャッシュ側(server.js)がTTL判定に使うため、取得処理とは別に公開している。
 */
export function computePriceFromDate(splitsFrom, today = new Date()) {
  const defaultFrom = toIsoDate(new Date(today.getTime() - 10 * DAY_MS));
  const oldestAllowed = toIsoDate(new Date(today.getTime() - (5 * 365 - 7) * DAY_MS));
  let from = splitsFrom && splitsFrom < defaultFrom ? splitsFrom : defaultFrom;
  if (from < oldestAllowed) from = oldestAllowed;
  return from;
}

/**
 * 直近終値・前日終値と、指定日以降の株式分割(併合)の一覧を返す(キャッシュなし)。
 *   splitsFrom: 分割を調べ始める日付(YYYY-MM-DD)。省略時は直近10日分だけ取得する。
 * 日足の調整係数(AdjFactor)が1以外の日を分割・併合として扱う。
 */
export async function fetchPriceInfo(code, splitsFrom) {
  const today = new Date();
  const from = computePriceFromDate(splitsFrom, today);

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

  return { price, date, prevClose, splits, coveredFrom: from };
}

export default {
  STATEMENT_FIELDS_TO_KEEP,
  compactStatements,
  fetchCompactStatements,
  computePriceFromDate,
  fetchPriceInfo,
};
