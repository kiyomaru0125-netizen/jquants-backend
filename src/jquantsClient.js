import fetch from 'node-fetch';

const BASE_URL = 'https://api.jquants.com/v1';

// メモリ上にトークンをキャッシュする（本番ではRedis等の永続ストアに置き換え推奨）
let cachedRefreshToken = null;
let cachedIdToken = null;
let idTokenExpiresAt = 0; // epoch ms

/**
 * メールアドレス・パスワードから refreshToken を取得する。
 * refreshToken は約1週間有効。
 */
async function fetchRefreshToken(mailaddress, password) {
  const res = await fetch(`${BASE_URL}/token/auth_user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mailaddress, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`J-Quants refreshToken取得に失敗: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.refreshToken;
}

/**
 * refreshToken から idToken を取得する。
 * idToken は約24時間有効で、実際のデータ取得APIのBearerトークンとして使う。
 */
async function fetchIdToken(refreshToken) {
  const res = await fetch(`${BASE_URL}/token/auth_refresh?refreshtoken=${refreshToken}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`J-Quants idToken取得に失敗: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.idToken;
}

/**
 * 有効なidTokenを返す。キャッシュが切れていれば自動で再取得する。
 */
async function getValidIdToken() {
  const now = Date.now();

  if (cachedIdToken && now < idTokenExpiresAt) {
    return cachedIdToken;
  }

  const { JQUANTS_MAIL, JQUANTS_PASSWORD } = process.env;
  if (!JQUANTS_MAIL || !JQUANTS_PASSWORD) {
    throw new Error('環境変数 JQUANTS_MAIL / JQUANTS_PASSWORD が設定されていません（.envを確認してください）');
  }

  if (!cachedRefreshToken) {
    cachedRefreshToken = await fetchRefreshToken(JQUANTS_MAIL, JQUANTS_PASSWORD);
  }

  try {
    cachedIdToken = await fetchIdToken(cachedRefreshToken);
  } catch (err) {
    // refreshTokenも切れている可能性があるので、1回だけ取り直してリトライ
    cachedRefreshToken = await fetchRefreshToken(JQUANTS_MAIL, JQUANTS_PASSWORD);
    cachedIdToken = await fetchIdToken(cachedRefreshToken);
  }

  // 安全マージンを取って23時間で失効扱いにする
  idTokenExpiresAt = now + 23 * 60 * 60 * 1000;
  return cachedIdToken;
}

/**
 * J-Quants APIへの共通GETリクエスト
 */
async function jquantsGet(path, params = {}) {
  const idToken = await getValidIdToken();
  const query = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`J-Quants API エラー (${path}): ${res.status} ${text}`);
  }
  return res.json();
}

/** 銘柄の基本情報（会社名・33業種区分など） */
export function fetchListedInfo(code) {
  return jquantsGet('/listed/info', { code });
}

/** 日次の株価四本値（直近の終値取得に使用） */
export function fetchDailyQuotes(code, { from, to } = {}) {
  return jquantsGet('/prices/daily_quotes', { code, from, to });
}

/** 財務情報（EPS・BPS・配当金等が含まれる決算情報） */
export function fetchStatements(code) {
  return jquantsGet('/fins/statements', { code });
}

export default {
  fetchListedInfo,
  fetchDailyQuotes,
  fetchStatements,
};
