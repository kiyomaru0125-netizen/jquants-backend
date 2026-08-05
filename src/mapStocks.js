// J-Quantsの生レスポンスを、Reactダッシュボード側の
// { code, name, industry, price, eps, bps, yieldPct, dividendFreq, sharesOutstanding }
// という形に変換するための処理。
//
// 注意: J-Quantsのレスポンスのフィールド名は契約プランやAPIバージョンで
// 変わることがあるため、実際に叩いてみて公式ドキュメントと突き合わせてください。
// https://jpx.gitbook.io/j-quants-ja/

/** 年度決算（TypeOfCurrentPeriod === 'FY'）だけを抽出し、開示日の新しい順に並べる */
function extractAnnualStatements(statements) {
  return statements
    .filter((s) => s.TypeOfCurrentPeriod === 'FY')
    .sort((a, b) => new Date(b.DisclosedDate) - new Date(a.DisclosedDate));
}

/** 数値化。空文字や'－'などJ-Quants特有の非数値表現をnullにする */
function toNumber(value) {
  if (value === null || value === undefined || value === '' || value === '－') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 年4回のうち配当が実施された回数を数える（簡易ヒューリスティック）。
 * 中間・期末の2回が最も一般的なので、データが取れない場合は2をデフォルトにする。
 */
function estimateDividendFreq(latestAnnual) {
  if (!latestAnnual) return 2;
  const quarterFields = [
    latestAnnual.ResultDividendPerShare1stQuarter,
    latestAnnual.ResultDividendPerShare2ndQuarter,
    latestAnnual.ResultDividendPerShare3rdQuarter,
    latestAnnual.ResultDividendPerShareFiscalYearEnd,
  ];
  const count = quarterFields.filter((v) => toNumber(v) !== null && toNumber(v) > 0).length;
  return count > 0 ? count : 2;
}

/**
 * 1銘柄分の { listedInfo, statements, latestClose } を
 * ダッシュボード表示用の1オブジェクトに変換する。
 */
export function mapToStockShape({ code, listedInfo, statements, latestClose }) {
  const annual = extractAnnualStatements(statements);
  const latestAnnual = annual[0] ?? null;

  const eps = toNumber(latestAnnual?.EarningsPerShare);
  const bps = toNumber(latestAnnual?.BookValuePerShare);
  const dividendPerShare =
    toNumber(latestAnnual?.ResultDividendPerShareAnnual) ??
    toNumber(latestAnnual?.ForecastDividendPerShareAnnual);
  const sharesOutstandingRaw = toNumber(
    latestAnnual?.NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock
  );

  const price = latestClose ?? null;
  const yieldPct =
    price && dividendPerShare ? Number(((dividendPerShare / price) * 100).toFixed(2)) : null;

  return {
    code,
    name: listedInfo?.CompanyName ?? code,
    industry: listedInfo?.Sector33CodeName ?? '不明',
    price: price ?? 0,
    eps: eps ?? 0,
    bps: bps ?? 0,
    yieldPct: yieldPct ?? 0,
    dividendFreq: estimateDividendFreq(latestAnnual),
    // J-Quantsは株数を「株」単位で返すため、ダッシュボード側の「百万株」単位に変換
    sharesOutstanding: sharesOutstandingRaw ? Math.round(sharesOutstandingRaw / 1_000_000) : null,
  };
}

/**
 * EPS推移グラフ用に、年度決算からEPSの時系列（最大10年分）を作る。
 */
export function mapToEpsHistory(statements, yearsLimit = 10) {
  const annual = extractAnnualStatements(statements).slice(0, yearsLimit).reverse();
  return annual.map((s) => ({
    year: new Date(s.CurrentFiscalYearEndDate).getFullYear(),
    eps: toNumber(s.EarningsPerShare),
  }));
}
