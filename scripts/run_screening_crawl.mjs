// 高配当株スクリーニング(毎日のメール通知)用の、東証全銘柄を1回だけクロールして
// 判定結果をdata/screening.jsonに書き出すバッチスクリプト。
// GitHub Actions(.github/workflows/daily-crawl.yml)から毎営業日1回実行される想定。
//
// これまではRender上で常時動いているサーバー(src/server.js)のインメモリキャッシュに
// 依存していたが、Renderの無料プランはスリープ/再起動でキャッシュが消えるため、
// メール通知の信頼性が不安定だった。このスクリプトはRenderとは独立して動き、
// 結果をリポジトリにコミットすることでその問題を解消する(詳細はREADME参照)。
//
// 1銘柄ごとにJ-Quants APIを2回叩く(決算サマリー・日足)ため、レート制限(60回/分)を
// 守りながら東証全銘柄(約4,400銘柄)を回すと2.5〜3時間程度かかる。

import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jquants from '../src/jquantsClient.js';
import { fetchCompactStatements, fetchPriceInfo } from '../src/fetchStockData.js';
import {
  mapToStockShape,
  mapToEpsHistory,
  mapToListedStockShape,
  getSplitCheckStartDate,
  getHistorySplitCheckStartDate,
} from '../src/mapStocks.js';
import { runScreening } from '../src/screening.js';

const OUTPUT_PATH = new URL('../data/screening.json', import.meta.url);
const PROGRESS_LOG_INTERVAL = 100;

function getPriceCheckStartDate(statements) {
  return getHistorySplitCheckStartDate(statements) ?? getSplitCheckStartDate(statements);
}

async function main() {
  console.log(`クロール開始: ${new Date().toISOString()}`);

  const rawListed = await jquants.fetchAllListedStocks();
  const listed = rawListed.map(mapToListedStockShape).filter((s) => s.code);
  console.log(`全銘柄一覧を取得: ${listed.length}件`);
  if (listed.length === 0) {
    throw new Error('全銘柄一覧が0件でした。J-Quants APIの状態を確認してください。');
  }

  const screeningRecords = new Map(); // code -> { stock, epsHistory }
  let processed = 0;
  let failed = 0;

  for (const { code, name, industry } of listed) {
    try {
      const statements = await fetchCompactStatements(code);
      const priceInfo = await fetchPriceInfo(code, getPriceCheckStartDate(statements));

      const stock = mapToStockShape({
        code,
        listedInfo: { CoName: name, S33Nm: industry },
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
    } catch (err) {
      failed += 1;
      console.error(`銘柄 ${code} の取得に失敗しました: ${err.message}`);
      // 1銘柄の失敗で全体を止めない
    }

    processed += 1;
    if (processed % PROGRESS_LOG_INTERVAL === 0) {
      console.log(`進行中: ${processed}/${listed.length}件(失敗 ${failed}件)`);
    }
  }

  console.log(`クロール完了: ${processed}件処理(うち失敗 ${failed}件)`);

  const result = runScreening(screeningRecords, { totalListed: listed.length });
  console.log(
    `判定結果: 該当 ${result.matches.length}件 / 惜しい銘柄 ${result.nearMisses.length}件 / ` +
      `判定対象 ${result.coverage.screened}件`
  );

  await mkdir(dirname(fileURLToPath(OUTPUT_PATH)), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf-8');
  console.log(`書き出し完了: ${fileURLToPath(OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error('クロールが失敗しました:', err);
  process.exitCode = 1;
});
