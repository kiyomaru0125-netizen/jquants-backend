// J-Quants API V2の生レスポンスを、Reactダッシュボード側の
// { code, name, industry, price, eps, bps, yieldPct, dividendFreq, sharesOutstanding }
// という形に変換するための処理。
//
// 注意: V2のレスポンスはカラム名が短縮形になっています（例: EPS, BPS, ShOutFY等）。
// 実際に一度APIを叩いて、公式ドキュメント（https://jpx-jquants.com/ja/spec）と
// 突き合わせて確認してください。仕様は今後も変わる可能性があります。

/** 年度決算（CurPerType === 'FY'）だけを抽出し、開示日の新しい順に並べる */
function extractAnnualStatements(records) {
  return records
    .filter((s) => s.CurPerType === 'FY')
    .sort((a, b) => new Date(b.DiscDate) - new Date(a.DiscDate));
}

/** 数値化。空文字や'－'などJ-Quants特有の非数値表現をnullにする */
function toNumber(value) {
  if (value === null || value === undefined || value === '' || value === '－') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 年何回配当が実施されたかを、四半期ごとの配当実績フィールドの
 * 非ゼロ件数から推定する（簡易ヒューリスティック）。
 */
function estimateDividendFreq(latestAnnual) {
  if (!latestAnnual) return 2;
  const quarterFields = [latestAnnual.Div1Q, latestAnnual.Div2Q, latestAnnual.Div3Q, latestAnnual.DivFY];
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

  const eps = toNumber(latestAnnual?.EPS);
  const bps = toNumber(latestAnnual?.BPS);
  const dividendPerShare = toNumber(latestAnnual?.DivAnn) ?? toNumber(latestAnnual?.FDivAnn);

  const shOutFY = toNumber(latestAnnual?.ShOutFY);
  const trShFY = toNumber(latestAnnual?.TrShFY);
  const sharesOutstandingRaw = shOutFY !== null ? shOutFY - (trShFY ?? 0) : null;

  const price = latestClose ?? null;
  const yieldPct =
    price && dividendPerShare ? Number(((dividendPerShare / price) * 100).toFixed(2)) : null;

  // listedInfo側のフィールド名は未確定要素があるため、複数の候補名を試す
  const name =
    listedInfo?.CoName ?? listedInfo?.CompanyName ?? listedInfo?.Name ?? code;
  const industry =
    listedInfo?.S33Nm ?? listedInfo?.Sector33CodeName ?? listedInfo?.Sector33Name ?? '不明';

  return {
    code,
    name,
    industry,
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
    year: new Date(s.CurFYEn).getFullYear(),
    eps: toNumber(s.EPS),
  }));
}
