"""
高配当株スクリーニングの結果をメールで送るスクリプト。
GitHub Actions(.github/workflows/daily-screening.yml)から毎営業日に実行される。

判定結果は、同じ日の早い時間帯に別のワークフロー(daily-crawl.yml →
scripts/run_screening_crawl.mjs)が東証全銘柄をクロールして data/screening.json に
書き出し、リポジトリにコミットしたものを読む(このスクリプトは外部サーバーには
アクセスしない)。以前はRenderのバックエンドにHTTPで問い合わせていたが、Render無料
プランのスリープ/再起動でキャッシュが消え判定が不安定になる問題があったため、
クロール自体をGitHub Actions側で完結させる構成に変更した。

必要な環境変数(GitHubの「Secrets」に登録する):
  GMAIL_USER          送信に使うGmailアドレス
  GMAIL_APP_PASSWORD  そのGmailの「アプリパスワード」(16文字)
  MAIL_TO             送り先(省略時は GMAIL_USER)
任意:
  DRY_RUN=1           送信せず、メール本文を mail_preview.html に書き出す(動作確認用。
                      前回結果ファイルの更新もしない)

前日との差分(新規に該当/該当から外れた銘柄)を表示するため、前回の該当銘柄一覧を
data/last_matches.json にコミットして持ち回る。ワークフロー側(daily-screening.yml)が
メール送信後にこのファイルをcommit & pushする。

Python標準ライブラリだけで動く(追加インストール不要)。
"""
import html
import json
import os
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

JST = timezone(timedelta(hours=9))
# クロール結果(data/screening.json)の生成日がこれより古い場合、クロールが失敗した
# 可能性があるとみなして注意書きを出す
STALE_WARNING_HOURS = 30
# 判定できた銘柄数がこの割合を下回るときは「一部取得できていないかもしれない」と注意書きを出す
COVERAGE_WARNING_RATIO = 0.9
SITE_URL = "https://sprightly-youtiao-91ad2f.netlify.app/"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SCREENING_PATH = DATA_DIR / "screening.json"
LAST_MATCHES_PATH = DATA_DIR / "last_matches.json"


def load_previous_codes(path=LAST_MATCHES_PATH):
    """前回実行時の該当銘柄コード一覧を読む。ファイルが無い/壊れている場合はNone(差分比較しない)"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        codes = data.get("codes")
        return set(codes) if isinstance(codes, list) else None
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def save_current_codes(codes, path=LAST_MATCHES_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"date": datetime.now(JST).strftime("%Y-%m-%d"), "codes": sorted(codes)}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_screening(path=SCREENING_PATH):
    """daily-crawl.ymlがコミットしたクロール結果を読む。無ければcrawlがまだ一度も
    成功していない(初回セットアップ直後など)ので、分かりやすいエラーにする。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise RuntimeError(
            f"{path} が見つかりません。daily-crawl.ymlがまだ一度も成功していない可能性があります。"
        ) from e
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{path} の内容が壊れています: {e}") from e


def staleness_note(result):
    """クロール結果の生成日時が古すぎる(=daily-crawlが失敗し続けている)場合に注意書きを返す"""
    generated_at = result.get("generatedAt")
    if not generated_at:
        return "判定結果の生成日時が記録されていません。"
    try:
        generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        return "判定結果の生成日時を解釈できませんでした。"

    age_hours = (datetime.now(timezone.utc) - generated).total_seconds() / 3600
    if age_hours > STALE_WARNING_HOURS:
        local = generated.astimezone(JST).strftime("%m/%d %H:%M")
        return f"クロール結果が古い可能性があります(生成日時: {local} JST)。daily-crawl.ymlの実行状況を確認してください。"
    return None


def fmt(value, suffix="", digits=None):
    if value is None:
        return "—"
    if digits is not None:
        value = round(value, digits)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value:,}{suffix}" if isinstance(value, int) else f"{value}{suffix}"


def build_mail(result, previous_codes=None):
    today = datetime.now(JST)
    date_label = f"{today.month}/{today.day}"
    matches = result.get("matches", [])
    near_misses = result.get("nearMisses", [])
    coverage = result.get("coverage", {})
    screened = coverage.get("screened") or 0
    total = coverage.get("totalListed") or 0
    c = result.get("criteria", {})

    if matches:
        subject = f"【高配当ボード】{date_label} 条件を満たす銘柄: {len(matches)}件"
    else:
        subject = f"【高配当ボード】{date_label} 該当銘柄なし"

    # 前回実行時との差分(新規に該当/該当から外れた銘柄)。前回ファイルが無い初回はNoneで比較しない
    by_code = {m["code"]: m for m in matches}
    newly_added = []
    dropped = []
    if previous_codes is not None:
        current_codes = set(by_code.keys())
        newly_added = [by_code[c2] for c2 in by_code if c2 not in previous_codes]
        dropped = sorted(previous_codes - current_codes)

    notes = []
    stale_note = staleness_note(result)
    if stale_note:
        notes.append(stale_note)
    if total and screened < total * COVERAGE_WARNING_RATIO:
        notes.append(
            f"クロールできたのは {screened:,} / {total:,} 銘柄のみです(一部の銘柄取得に失敗した可能性があります)。"
        )

    criteria_lines = [
        f"配当利回り {c.get('minYieldPct')}%以上",
        "EPSが5年前より増加",
        f"PER {c.get('maxPer')}倍以下 または 業界上位{c.get('industryTopN')}社平均以下",
        f"ROE {c.get('minRoe')}%以上 / ROA {c.get('minRoa')}%以上 / ROIC {c.get('minRoic')}%以上(近似)",
        f"流動比率 {c.get('minCurrentRatio')}%以上 / 配当性向 {c.get('maxPayoutRatio')}%以下",
        f"◎ = PBR {c.get('goodPbr', 1):.2f}倍以下",
    ]
    not_checked = result.get("notChecked", [])

    # --- テキスト版 ---
    text = [subject, ""]
    text += notes
    if newly_added:
        added_labels = [f"{m['code']} {m['name']}" for m in newly_added]
        text.append(f"🆕 新規に該当: {', '.join(added_labels)}")
    if dropped:
        text.append(f"➖ 該当から外れた: {', '.join(dropped)}")
    if newly_added or dropped:
        text.append("")
    if matches:
        for m in matches:
            mark = "◎ " if m.get("goodPbr") else ""
            eps_from = m.get("epsFrom") or {}
            text.append(f"{mark}{m['code']} {m['name']}({m.get('industry', '')})")
            text.append(
                f"  株価 {fmt(m.get('price'), '円')} / 利回り {fmt(m.get('yieldPct'), '%')} / "
                f"PER {fmt(m.get('per'), '倍')}(業界平均 {fmt(m.get('industryPer'), '倍')}) / PBR {fmt(m.get('pbr'), '倍')}"
            )
            text.append(
                f"  ROE {fmt(m.get('roe'), '%')} / ROA {fmt(m.get('roa'), '%')} / ROIC {fmt(m.get('roic'), '%')} / "
                f"流動比率 {fmt(m.get('currentRatio'), '%')} / 配当性向 {fmt(m.get('payoutRatio'), '%')} / "
                f"EPS {fmt(eps_from.get('eps'), '円', 1)}({eps_from.get('year', '?')}年)→{fmt(m.get('eps'), '円', 1)}"
            )
            text.append("")
    else:
        text.append("今日は全条件を満たす銘柄はありませんでした。")
        text.append("")
    if near_misses:
        text.append(f"■ 惜しい銘柄(あと1条件): {len(near_misses)}件")
        for m in near_misses:
            missed = m.get("missedCheck") or {}
            text.append(f"{m['code']} {m['name']}({m.get('industry', '')}) — 届かず: {missed.get('label', '?')}")
        text.append("")
    text.append("■ 判定条件")
    text += [f"・{line}" for line in criteria_lines]
    text += [f"・判定していない条件: {n}" for n in not_checked]
    text.append(f"・判定済み銘柄数: {screened:,} / {total:,}")
    text.append("")
    text.append(f"詳細はボードで確認できます: {SITE_URL}")
    text.append("※ 自動判定の結果です。投資判断はご自身でお願いします。")

    # --- HTML版 ---
    esc = html.escape
    rows = []
    for m in matches:
        eps_from = m.get("epsFrom") or {}
        rows.append(
            "<tr>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd'>{'◎ ' if m.get('goodPbr') else ''}<b>{esc(m['code'])} {esc(m['name'])}</b><br>"
            f"<span style='color:#888;font-size:12px'>{esc(m.get('industry', ''))}</span></td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('price'), '円')}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'><b>{fmt(m.get('yieldPct'), '%')}</b></td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('per'), '倍')}<br>"
            f"<span style='color:#888;font-size:12px'>業界 {fmt(m.get('industryPer'), '倍')}</span></td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('pbr'), '倍')}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('roe'), '%')} / {fmt(m.get('roa'), '%')} / {fmt(m.get('roic'), '%')}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('currentRatio'), '%')}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(m.get('payoutRatio'), '%')}</td>"
            f"<td style='padding:6px;border-bottom:1px solid #ddd;text-align:right'>{fmt(eps_from.get('eps'), '', 1)}→{fmt(m.get('eps'), '', 1)}<br>"
            f"<span style='color:#888;font-size:12px'>{esc(str(eps_from.get('year', '?')))}年〜</span></td>"
            "</tr>"
        )
    th = "style='padding:6px;border-bottom:2px solid #333;text-align:right;font-size:12px'"
    table = (
        "<table style='border-collapse:collapse;font-size:13px;width:100%'>"
        f"<tr><th style='padding:6px;border-bottom:2px solid #333;text-align:left;font-size:12px'>銘柄</th>"
        f"<th {th}>株価</th><th {th}>利回り</th><th {th}>PER</th><th {th}>PBR</th>"
        f"<th {th}>ROE/ROA/ROIC</th><th {th}>流動比率</th><th {th}>配当性向</th><th {th}>EPS</th></tr>"
        + "".join(rows)
        + "</table>"
        if matches
        else "<p>今日は全条件を満たす銘柄はありませんでした。</p>"
    )
    notes_html = "".join(f"<p style='color:#b45309'>⚠️ {esc(n)}</p>" for n in notes)
    diff_html = ""
    if newly_added:
        added_html = ", ".join(f"<b>{esc(m['code'])} {esc(m['name'])}</b>" for m in newly_added)
        diff_html += f"<p>🆕 新規に該当: {added_html}</p>"
    if dropped:
        diff_html += f"<p>➖ 該当から外れた: {esc(', '.join(dropped))}</p>"
    near_miss_html = ""
    if near_misses:
        nm_rows = "".join(
            f"<li><b>{esc(m['code'])} {esc(m['name'])}</b>"
            f"<span style='color:#888'>({esc(m.get('industry', ''))})</span> — "
            f"届かず: {esc((m.get('missedCheck') or {}).get('label', '?'))}</li>"
            for m in near_misses
        )
        near_miss_html = (
            f"<h3 style='font-size:14px;margin-top:24px'>惜しい銘柄(あと1条件): {len(near_misses)}件</h3>"
            f"<ul style='font-size:13px'>{nm_rows}</ul>"
        )
    criteria_html = "".join(f"<li>{esc(line)}</li>" for line in criteria_lines)
    criteria_html += "".join(f"<li>判定していない条件: {esc(n)}</li>" for n in not_checked)
    body_html = (
        "<div style='font-family:sans-serif;color:#222;max-width:760px'>"
        f"<h2 style='font-size:18px'>{esc(subject)}</h2>"
        f"{notes_html}{diff_html}{table}{near_miss_html}"
        f"<h3 style='font-size:14px;margin-top:24px'>判定条件</h3><ul style='font-size:13px'>{criteria_html}"
        f"<li>判定済み銘柄数: {screened:,} / {total:,}</li></ul>"
        f"<p style='font-size:13px'><a href='{SITE_URL}'>日本株高配当ボードを開く</a></p>"
        "<p style='font-size:11px;color:#888'>※ 自動判定の結果です。投資判断はご自身でお願いします。</p>"
        "</div>"
    )
    return subject, "\n".join(text), body_html


def send(subject, text, body_html):
    user = os.environ["GMAIL_USER"]
    password = os.environ["GMAIL_APP_PASSWORD"].replace(" ", "")
    to = os.environ.get("MAIL_TO") or user

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60) as smtp:
        smtp.login(user, password)
        smtp.sendmail(user, [a.strip() for a in to.split(",")], msg.as_string())
    print(f"送信しました: {subject} → {to}")


def main():
    result = load_screening()
    previous_codes = load_previous_codes()
    subject, text, body_html = build_mail(result, previous_codes)
    if os.environ.get("DRY_RUN") == "1":
        with open("mail_preview.html", "w", encoding="utf-8") as f:
            f.write(body_html)
        print(text)
        return
    send(subject, text, body_html)
    # 次回実行時との差分表示に使うため、今回の該当銘柄を保存する
    # (ワークフロー側がこのファイルをcommit & pushする)
    save_current_codes([m["code"] for m in result.get("matches", [])])


if __name__ == "__main__":
    main()
