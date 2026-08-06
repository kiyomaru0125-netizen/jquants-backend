import fetch from 'node-fetch';

// J-Quants API V2のベースURL(2025年12月のV2リリース以降、V1のトークン認証は廃止)
const BASE_URL = 'https://api.jquants.com/v2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- グローバルなリクエスト間隔制御 ---
// 検索結果の複数銘柄が同時に問い合わせてきても、実際にJ-Quantsへ飛ぶリクエストは
// アプリ全体でこの1本のキューを通じて必ず直列化・間隔調整される。
// (個々のエンドポイント側で独自にsleepを入れるだけだと、複数リクエストが重なった時に
//  合計のペースが上限を超えてしまうため、ここで一元管理する)
const MIN_INTERVAL_MS = 1100; // Lightプラン(60回/分)に対して安全マージンを取った間隔
let queue = Promise.resolve();
let lastCallAt = 0;

function scheduleThrottled(fn) {
  const result = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  // 1件が失敗してもキュー自体は途切れさせない
  queue = result.catch(() => {});
  return result;
}

/**
 * V2 APIへの共通GETリクエスト。
 * 認証は x-api-key ヘッダーにAPIキーを付与するだけ（トークン取得・更新は不要）。
 * 実際のHTTPリクエストは上記のグローバルキュー経由で直列化され、
 * レート制限(429)に当たった場合は少し待って自動的に再試行する。
 */
async function jquantsGet(path, params = {}, retriesLeft = 3) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) {
    throw new Error('環境変数 JQUANTS_API_KEY が設定されていません（.envを確認してください）');
  }

  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
  ).toString();
  const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`;

  const res = await scheduleThrottled(() => fetch(url, { headers: { 'x-api-key': apiKey } }));

  if (res.status === 429 && retriesLeft > 0) {
    // レート制限。少し長めに待ってから同じリクエストを再試行する
    await sleep(3000);
    return jquantsGet(path, params, retriesLeft - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`J-Quants API エラー (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * J-Quants API V2は5桁の証券コードを使用する（例: 7203 → 72030）。
 * ダッシュボード側は従来通り4桁で扱い、APIを叩く直前だけ5桁に変換する。
 */
function toJQuantsCode(code) {
  return code.length === 4 ? `${code}0` : code;
}

/** 銘柄の基本情報（会社名・業種区分など）。V1の /listed/info に相当 */
export function fetchListedInfo(code) {
  return jquantsGet('/equities/master', { code: toJQuantsCode(code) });
}

/**
 * コード・日付を指定せず全銘柄分の一覧を取得する（ページネーションあり）。
 * 東証上場の全銘柄（約4,000銘柄）が対象になるため、pagination_keyを使って
 * 複数回に分けてすべて取得する。
 */
export async function fetchAllListedStocks() {
  const all = [];
  let paginationKey;

  do {
    const res = await jquantsGet('/equities/master', paginationKey ? { pagination_key: paginationKey } : {});
    const page = res.data ?? [];
    all.push(...page);
    paginationKey = res.pagination_key;
  } while (paginationKey);

  return all;
}

/** 日次の株価四本値（直近の終値取得に使用）。V1の /prices/daily_quotes に相当 */
export function fetchDailyQuotes(code, { from, to } = {}) {
  return jquantsGet('/equities/bars/daily', { code: toJQuantsCode(code), from, to });
}

/** 財務情報サマリー（EPS・BPS・配当金等）。V1の /fins/statements に相当 */
export function fetchStatements(code) {
  return jquantsGet('/fins/summary', { code: toJQuantsCode(code) });
}

export default {
  fetchListedInfo,
  fetchAllListedStocks,
  fetchDailyQuotes,
  fetchStatements,
};
