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
 * statementsから直近の売上高だけを軽量に取り出す。
 * 業界ごとの売上ランキングを作る際、mapToStockShapeをフルに呼ばずに済むようにするため。
 */
export function getLatestSales(statements) {
  const annual = extractAnnualStatements(statements);
  const latest = annual[0];
  return latest ? toNumber(latest.Sales) : null;
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
 * J-Quants API V2は5桁の証券コードを使用する（例: 72030）。
 * ダッシュボード側は4桁で扱うため、末尾の0を取り除いて変換する。
 * （優先株式など元々5桁で意味を持つコードは、稀に取りこぼす可能性がある簡易変換）
 */
function toDisplayCode(jquantsCode) {
  if (!jquantsCode) return jquantsCode;
  return jquantsCode.length === 5 && jquantsCode.endsWith('0') ? jquantsCode.slice(0, 4) : jquantsCode;
}

/**
 * 全銘柄一覧(/equities/master、コード未指定)の1レコードを、
 * 検索・一覧表示用の軽量な形 { code, name, industry } に変換する。
 * 株価やPER/PBR/EPSは含まない（必要になった時点で個別に取得する）。
 */
export function mapToListedStockShape(record) {
  return {
    code: toDisplayCode(record.Code),
    name: record.CoName ?? record.CompanyName ?? record.Name ?? record.Code,
    industry: record.S33Nm ?? record.Sector33CodeName ?? record.Sector33Name ?? '不明',
  };
}

/**
 * 1銘柄分の { listedInfo, statements, latestClose, priceDate } を
 * ダッシュボード表示用の1オブジェクトに変換する。
 */
export function mapToStockShape({ code, listedInfo, statements, latestClose, priceDate }) {
  const annual = extractAnnualStatements(statements);
  // 「業績予想の修正」など、実績のEPSを含まない開示がFY扱いで最新に来ることがあるため、
  // 単純に一番新しい日付のレコードではなく、EPSが実際に入っている中で最新のものを優先する
  const latestAnnual = annual.find((a) => toNumber(a.EPS) !== null) ?? annual[0] ?? null;

  const eps = toNumber(latestAnnual?.EPS);
  const bps = toNumber(latestAnnual?.BPS);
  const dividendPerShare = toNumber(latestAnnual?.DivAnn) ?? toNumber(latestAnnual?.FDivAnn);
  const sales = toNumber(latestAnnual?.Sales);

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
    priceDate: priceDate ?? null,
    eps: eps ?? 0,
    bps: bps ?? 0,
    yieldPct: yieldPct ?? 0,
    dividendFreq: estimateDividendFreq(latestAnnual),
    // 売上高(円)。並び替え用途のほか、表示にも使う
    sales: sales ?? null,
    // J-Quantsは株数を「株」単位で返すため、ダッシュボード側の「百万株」単位に変換
    sharesOutstanding: sharesOutstandingRaw ? Math.round(sharesOutstandingRaw / 1_000_000) : null,
  };
}

/** 年度(CurFYEnの年)ごとに、最新のDiscDateを持つレコードだけへ集約する(重複開示の除去) */
function dedupeByYear(records) {
  const byYear = new Map(); // year -> record
  for (const s of records) {
    const year = new Date(s.CurFYEn).getFullYear();
    const existing = byYear.get(year);
    if (!existing || new Date(s.DiscDate) > new Date(existing.DiscDate)) {
      byYear.set(year, s);
    }
  }
  return byYear;
}

/**
 * EPS推移グラフ用に、年度決算からEPSの時系列（最大10年分）を作る。
 * 「業績予想の修正」等でEPSを含まないFY扱いのレコードは、グラフを歪めるので除外する。
 * また、同一の決算期（年度）について複数回開示されている場合（予想の修正等）は、
 * その年度で最新の1件だけに集約する（同じ年が重複して並ぶのを防ぐ）。
 */
export function mapToEpsHistory(statements, yearsLimit = 10) {
  const withEps = extractAnnualStatements(statements).filter((s) => toNumber(s.EPS) !== null);
  const byYear = dedupeByYear(withEps);

  const dedupedSortedDesc = [...byYear.entries()].sort((a, b) => b[0] - a[0]); // 年の新しい順
  const limited = dedupedSortedDesc.slice(0, yearsLimit).reverse(); // 古い→新しい順に戻す

  return limited.map(([year, s]) => ({
    year,
    eps: toNumber(s.EPS),
  }));
}

/**
 * 年間配当(実績)の推移と、連続増配年数を作る。
 * Lightプランで取得できる範囲(最大5年)を想定したデフォルトになっている。
 * 「増配」は前年より実際に配当額が増えている場合のみカウントする（同額維持は増配としない）。
 */
export function mapToDividendHistory(statements, yearsLimit = 5) {
  const withDiv = extractAnnualStatements(statements).filter((s) => toNumber(s.DivAnn) !== null);
  const byYear = dedupeByYear(withDiv);

  const sortedDesc = [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  const limited = sortedDesc.slice(0, yearsLimit).reverse(); // 古い→新しい順

  const history = limited.map(([year, s]) => ({
    year,
    dividend: toNumber(s.DivAnn),
  }));

  // 最新年から遡って、前年より増えている連続回数を数える
  let consecutiveIncreaseYears = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].dividend > history[i - 1].dividend) {
      consecutiveIncreaseYears += 1;
    } else {
      break;
    }
  }

  return { history, consecutiveIncreaseYears };
}
