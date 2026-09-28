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

// ---------------------------------------------------------------------------
// 株式分割(併合)の補正
//
// 決算のEPS・BPS・配当は「その決算時点の株数」基準の1株あたり値なので、その後に株式分割が
// あると、今の株価と比べた利回り・PER・PBRが分割比率ぶんずれる(1:3分割なら利回りが3倍に見える)。
// そこで日足の調整係数(AdjFactor。1:2分割なら権利落ち日に0.5)を使い、決算以降の分割を掛け合わせて
// 「今の株数基準」にそろえる。
//
// どの時点以降の分割を掛けるかは値によって違う:
//   - EPS・BPS・予想配当: 決算発表日(DiscDate)より後の分割。期末後〜発表前の分割は、
//     会計基準上すでに分割後の株数で計算されて開示されるため。
//   - 実績配当・発行済株式数: 決算期末(CurFYEn)の少し前より後の分割。3/31基準日・4/1効力発生の
//     分割は権利落ち日が期末の数日前になる一方、期末配当は分割前の株数に対して支払われるため。
// ---------------------------------------------------------------------------

/** 期末の何日前以降の権利落ちを「期末後の分割」とみなすか(権利落ち日は基準日の数営業日前) */
const FY_END_SPLIT_MARGIN_DAYS = 7;

/** 'YYYY-MM-DD' / 'YYYYMMDD' / Date文字列を 'YYYY-MM-DD' にそろえる */
function toIsoDate(value) {
  if (!value) return null;
  const str = String(value);
  if (/^\d{8}$/.test(str)) return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function shiftIsoDate(value, days) {
  const iso = toIsoDate(value);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 指定日より後に権利落ちした分割・併合の調整係数をすべて掛け合わせる(該当なしなら1) */
function splitFactorAfter(splits, afterDate) {
  const after = toIsoDate(afterDate);
  if (!after || !Array.isArray(splits)) return 1;
  let factor = 1;
  for (const s of splits) {
    const date = toIsoDate(s.date);
    if (date && date > after && Number.isFinite(s.factor) && s.factor > 0) factor *= s.factor;
  }
  return factor;
}

const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

/** 決算発表日より後の分割の係数(EPS・BPS・予想配当用) */
const factorSinceDisclosure = (splits, record) => splitFactorAfter(splits, record?.DiscDate);
/** 決算期末の少し前より後の分割の係数(実績配当・発行済株式数用) */
const factorSinceFyEnd = (splits, record) =>
  splitFactorAfter(splits, shiftIsoDate(record?.CurFYEn, -FY_END_SPLIT_MARGIN_DAYS));

/**
 * 「業績予想の修正」など、実績のEPSを含まない開示がFY扱いで最新に来ることがあるため、
 * 単純に一番新しい日付のレコードではなく、EPSが実際に入っている中で最新のものを優先する
 */
function pickLatestAnnual(statements) {
  const annual = extractAnnualStatements(statements);
  return annual.find((a) => toNumber(a.EPS) !== null) ?? annual[0] ?? null;
}

/**
 * 1銘柄の表示用データ(mapToStockShape)の分割補正に必要な、日足を取り始める日付。
 * 直近の年度決算の期末の少し前から。決算が無ければnull(直近の終値だけ取ればよい)。
 */
export function getSplitCheckStartDate(statements) {
  return shiftIsoDate(pickLatestAnnual(statements)?.CurFYEn, -FY_END_SPLIT_MARGIN_DAYS);
}

/**
 * EPS・配当の推移(最大5年分)の分割補正に必要な、日足を取り始める日付。
 * 推移に使う最も古い年度の期末の少し前から。
 */
export function getHistorySplitCheckStartDate(statements, yearsLimit = 5) {
  const usable = extractAnnualStatements(statements).filter(
    (s) => toNumber(s.EPS) !== null || toNumber(s.DivAnn) !== null
  );
  const years = [...dedupeByYear(usable).entries()].sort((a, b) => b[0] - a[0]).slice(0, yearsLimit);
  const fyEnds = years.map(([, s]) => toIsoDate(s.CurFYEn)).filter(Boolean).sort();
  return fyEnds.length > 0 ? shiftIsoDate(fyEnds[0], -FY_END_SPLIT_MARGIN_DAYS) : null;
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
 * 非ゼロ件数から推定する（簡易ヒューリスティック）。無配なら0、不明ならnull。
 */
function estimateDividendFreq(latestAnnual) {
  if (!latestAnnual) return null;
  const quarterFields = [latestAnnual.Div1Q, latestAnnual.Div2Q, latestAnnual.Div3Q, latestAnnual.DivFY];
  const count = quarterFields.filter((v) => toNumber(v) !== null && toNumber(v) > 0).length;
  if (count > 0) return count;
  // 年間配当が0と開示されていれば無配(0回)。何も分からなければnull(不明)
  return toNumber(latestAnnual.DivAnn) === 0 ? 0 : null;
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
 * 1銘柄分の { listedInfo, statements, latestClose, priceDate, splits } を
 * ダッシュボード表示用の1オブジェクトに変換する。
 * splits は決算期末以降の株式分割・併合の一覧 [{ date, factor }]。
 * 1株あたりの値と株数は、これを使って今の株数基準に補正する。
 * 取得できなかった値は0ではなくnullで返す(「0円」「利回り0%」と区別するため)。
 */
export function mapToStockShape({ code, listedInfo, statements, latestClose, priceDate, prevClose, splits = [] }) {
  const latestAnnual = pickLatestAnnual(statements);

  const discFactor = factorSinceDisclosure(splits, latestAnnual);
  const fyEndFactor = factorSinceFyEnd(splits, latestAnnual);

  const rawEps = toNumber(latestAnnual?.EPS);
  const rawBps = toNumber(latestAnnual?.BPS);
  const eps = rawEps === null ? null : round2(rawEps * discFactor);
  const bps = rawBps === null ? null : round2(rawBps * discFactor);

  // 実績配当を優先し、無ければ予想配当。補正に使う係数は、それぞれの基準時点に合わせる
  const actualDiv = toNumber(latestAnnual?.DivAnn);
  const forecastDiv = toNumber(latestAnnual?.FDivAnn);
  const dividendPerShare =
    actualDiv !== null
      ? round2(actualDiv * fyEndFactor)
      : forecastDiv !== null
        ? round2(forecastDiv * discFactor)
        : null;
  const sales = toNumber(latestAnnual?.Sales);
  const netProfit = toNumber(latestAnnual?.NP);
  const totalAssets = toNumber(latestAnnual?.TA);

  // ROE(自己資本利益率) = EPS ÷ BPS × 100 (1株あたりで計算しているだけで、NP÷Eqと同義)
  const roe = eps !== null && bps ? Number(((eps / bps) * 100).toFixed(1)) : null;
  // ROA(総資産利益率) = 純利益 ÷ 総資産 × 100
  const roa = netProfit !== null && totalAssets ? Number(((netProfit / totalAssets) * 100).toFixed(1)) : null;

  const shOutFY = toNumber(latestAnnual?.ShOutFY);
  const trShFY = toNumber(latestAnnual?.TrShFY);
  // 分割で株数は増える(係数0.5なら2倍)ため、係数で割る
  const sharesOutstandingRaw = shOutFY !== null ? (shOutFY - (trShFY ?? 0)) / fyEndFactor : null;

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
    price: price ?? null,
    priceDate: priceDate ?? null,
    // 前日終値(画面の前日比に使う)
    prevClose: prevClose ?? null,
    eps: eps ?? null,
    bps: bps ?? null,
    // 無配(配当0円と開示)なら0、配当が分からなければnull
    yieldPct: yieldPct ?? (price && dividendPerShare === 0 ? 0 : null),
    dividendFreq: estimateDividendFreq(latestAnnual),
    // 売上高(円)。並び替え用途のほか、表示にも使う
    sales: sales ?? null,
    roe: roe,
    roa: roa,
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
export function mapToEpsHistory(statements, yearsLimit = 10, splits = []) {
  const withEps = extractAnnualStatements(statements).filter((s) => toNumber(s.EPS) !== null);
  const byYear = dedupeByYear(withEps);

  const dedupedSortedDesc = [...byYear.entries()].sort((a, b) => b[0] - a[0]); // 年の新しい順
  const limited = dedupedSortedDesc.slice(0, yearsLimit).reverse(); // 古い→新しい順に戻す

  // 各年のEPSを今の株数基準にそろえる(分割前の年がグラフ上で不自然に高く見えないように)
  return limited.map(([year, s]) => ({
    year,
    eps: round2(toNumber(s.EPS) * factorSinceDisclosure(splits, s)),
  }));
}

/**
 * 年間配当(実績)の推移と、連続増配年数を作る。
 * Lightプランで取得できる範囲(最大5年)を想定したデフォルトになっている。
 * 「増配」は前年より実際に配当額が増えている場合のみカウントする（同額維持は増配としない）。
 * 株式分割があった場合は、今の株数基準に補正してから比較する。
 */
export function mapToDividendHistory(statements, yearsLimit = 5, splits = []) {
  const withDiv = extractAnnualStatements(statements).filter((s) => toNumber(s.DivAnn) !== null);
  const byYear = dedupeByYear(withDiv);

  const sortedDesc = [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  const limited = sortedDesc.slice(0, yearsLimit).reverse(); // 古い→新しい順

  // 各年の配当を今の株数基準にそろえる(分割した年が「減配」に見えないように)
  const history = limited.map(([year, s]) => ({
    year,
    dividend: round2(toNumber(s.DivAnn) * factorSinceFyEnd(splits, s)),
  }));

  // 最新年から遡って、前年より増えている連続回数を数える。
  // 分割補正後の値は端数処理の差(例: 100円÷3=33.33円 と 会社発表の33.34円)が出るため、
  // 0.5%未満の差は「同額」とみなす
  const INCREASE_TOLERANCE = 0.005;
  let consecutiveIncreaseYears = 0;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].dividend > history[i - 1].dividend * (1 + INCREASE_TOLERANCE)) {
      consecutiveIncreaseYears += 1;
    } else {
      break;
    }
  }

  return { history, consecutiveIncreaseYears };
}
