// 高配当株のスクリーニング(毎日のメール通知用)
//
// STEP① 土俵に上げる株
//   ① 配当利回り 3.5%以上
//   ② EPSが5年前(取得できる最も古い年度)より増えている
//   ③ PER 15倍以下、または同業界の時価総額上位5社の平均PER以下
//   ④ PBR 1.00以下 … 必須ではなく、満たしていれば「◎」を付けるだけ
// STEP② R三兄弟
//   ① ROE 12%以上
//   ② ROA 10%以上
//   ③ ROIC 10%以上 (近似値。mapStocks.js の計算方法を参照)
// STEP③
//   ① 流動比率 150%以上 … 決算サマリーにデータが無いため判定していない
//   ② 配当性向 40%以下
//
// 条件の数値を変えたい場合は、下の CRITERIA だけ直せばよい。

export const CRITERIA = {
  minYieldPct: 3.5,
  maxPer: 15,
  industryTopN: 5,
  goodPbr: 1.0,
  minRoe: 12,
  minRoa: 10,
  minRoic: 10,
  maxPayoutRatio: 40,
  // EPS推移の比較に最低限必要な年数(これより短いと「5年前より増えている」を判断しない)
  minEpsYears: 3,
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 業界ごとに、時価総額の上位N社の平均PER(黒字の銘柄のみ)を計算する。
 * records: [{ stock }] (stockは mapToStockShape の結果)
 */
export function industryAveragePer(records, topN = CRITERIA.industryTopN) {
  const byIndustry = new Map();
  for (const { stock } of records) {
    if (!stock.industry || stock.industry === '不明') continue;
    const marketCap = isNum(stock.price) && isNum(stock.sharesOutstanding) ? stock.price * stock.sharesOutstanding : null;
    if (marketCap === null) continue;
    if (!byIndustry.has(stock.industry)) byIndustry.set(stock.industry, []);
    byIndustry.get(stock.industry).push({ stock, marketCap });
  }

  const result = new Map();
  for (const [industry, list] of byIndustry) {
    const top = list.sort((a, b) => b.marketCap - a.marketCap).slice(0, topN);
    const pers = top.map(({ stock }) => per(stock)).filter((v) => v !== null);
    if (pers.length > 0) {
      result.set(industry, Number((pers.reduce((a, b) => a + b, 0) / pers.length).toFixed(1)));
    }
  }
  return result;
}

function per(stock) {
  return isNum(stock.price) && isNum(stock.eps) && stock.eps > 0 ? Number((stock.price / stock.eps).toFixed(1)) : null;
}
function pbr(stock) {
  return isNum(stock.price) && isNum(stock.bps) && stock.bps > 0 ? Number((stock.price / stock.bps).toFixed(2)) : null;
}

/**
 * 1銘柄を判定する。
 * record: { stock, epsHistory } / industryPer: その銘柄の業界の上位平均PER(無ければnull)
 * 戻り値: { passed, checks: [{ key, label, ok, value }], ... }
 */
export function evaluateStock({ stock, epsHistory }, industryPer) {
  const stockPer = per(stock);
  const stockPbr = pbr(stock);
  const epsFirst = epsHistory?.[0] ?? null;
  const epsLast = epsHistory?.[epsHistory.length - 1] ?? null;
  const epsGrowing =
    epsHistory && epsHistory.length >= CRITERIA.minEpsYears && isNum(epsFirst?.eps) && isNum(epsLast?.eps)
      ? epsLast.eps > epsFirst.eps
      : null;

  const perOk =
    stockPer !== null && (stockPer <= CRITERIA.maxPer || (industryPer !== null && stockPer <= industryPer));

  const checks = [
    { key: 'yield', label: `配当利回り${CRITERIA.minYieldPct}%以上`, ok: isNum(stock.yieldPct) && stock.yieldPct >= CRITERIA.minYieldPct, value: stock.yieldPct },
    { key: 'eps', label: 'EPSが5年前より増加', ok: epsGrowing === true, value: epsFirst && epsLast ? { from: epsFirst, to: epsLast } : null },
    { key: 'per', label: `PER${CRITERIA.maxPer}倍以下 または 業界上位${CRITERIA.industryTopN}社平均以下`, ok: perOk, value: stockPer },
    { key: 'roe', label: `ROE${CRITERIA.minRoe}%以上`, ok: isNum(stock.roe) && stock.roe >= CRITERIA.minRoe, value: stock.roe },
    { key: 'roa', label: `ROA${CRITERIA.minRoa}%以上`, ok: isNum(stock.roa) && stock.roa >= CRITERIA.minRoa, value: stock.roa },
    { key: 'roic', label: `ROIC${CRITERIA.minRoic}%以上(近似)`, ok: isNum(stock.roic) && stock.roic >= CRITERIA.minRoic, value: stock.roic },
    { key: 'payout', label: `配当性向${CRITERIA.maxPayoutRatio}%以下`, ok: isNum(stock.payoutRatio) && stock.payoutRatio <= CRITERIA.maxPayoutRatio, value: stock.payoutRatio },
  ];

  return {
    passed: checks.every((c) => c.ok),
    goodPbr: stockPbr !== null && stockPbr <= CRITERIA.goodPbr,
    per: stockPer,
    pbr: stockPbr,
    industryPer,
    checks,
  };
}

/**
 * キャッシュ済みの全銘柄を判定し、全条件を満たした銘柄を利回りの高い順に返す。
 * records: Map<code, { stock, epsHistory }>
 */
export function runScreening(records, { totalListed = null } = {}) {
  const list = [...records.values()];
  const industryPers = industryAveragePer(list);

  const matches = [];
  const stepCounts = { yield: 0, eps: 0, per: 0, roe: 0, roa: 0, roic: 0, payout: 0 };
  for (const record of list) {
    const result = evaluateStock(record, industryPers.get(record.stock.industry) ?? null);
    for (const c of result.checks) if (c.ok) stepCounts[c.key] += 1;
    if (result.passed) {
      const s = record.stock;
      matches.push({
        code: s.code,
        name: s.name,
        industry: s.industry,
        price: s.price,
        priceDate: s.priceDate,
        yieldPct: s.yieldPct,
        dividendFreq: s.dividendFreq,
        eps: s.eps,
        epsFrom: result.checks.find((c) => c.key === 'eps').value?.from ?? null,
        per: result.per,
        industryPer: result.industryPer,
        pbr: result.pbr,
        goodPbr: result.goodPbr,
        roe: s.roe,
        roa: s.roa,
        roic: s.roic,
        payoutRatio: s.payoutRatio,
      });
    }
  }

  matches.sort((a, b) => (b.yieldPct ?? 0) - (a.yieldPct ?? 0));

  return {
    generatedAt: new Date().toISOString(),
    criteria: CRITERIA,
    notChecked: ['流動比率150%以上(決算サマリーにデータが無いため)'],
    coverage: { screened: list.length, totalListed },
    // 各条件を単独で満たした銘柄数(条件が厳しすぎないかの目安)
    passCounts: stepCounts,
    matches,
  };
}
