"""
高配当株スクリーニングの結果をメールで送るスクリプト。
GitHub Actions(.github/workflows/daily-screening.yml)から毎営業日に実行される。

必要な環境変数(GitHubの「Secrets」に登録する):
  GMAIL_USER          送信に使うGmailアドレス
  GMAIL_APP_PASSWORD  そのGmailの「アプリパスワード」(16文字)
  MAIL_TO             送り先(省略時は GMAIL_USER)
任意:
  SCREEN_URL          判定結果のURL(省略時はRenderのバックエンド)
  DRY_RUN=1           送信せず、メール本文を mail_preview.html に書き出す(動作確認用)

Python標準ライブラリだけで動く(追加インストール不要)。
"""
import html
import json
import os
import smtplib
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SCREEN_URL = os.environ.get("SCREEN_URL", "https://jquants-backend.onrender.com/api/screen")
JST = timezone(timedelta(hours=9))
# 判定済みの銘柄がこの割合を下回るときは「サーバー再起動直後で判定が途中」と注意書きを出す
COVERAGE_WARNING_RATIO = 0.9
SITE_URL = "https://sprightly-youtiao-91ad2f.netlify.app/"


def fetch_screening():
    """Renderがスリープから起きるまで時間がかかることがあるので、数回やり直す"""
    last_error = None
    for attempt in range(6):
        try:
            with urllib.request.urlopen(SCREEN_URL, timeout=90) as res:
                return json.loads(res.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last_error = e
            print(f"取得失敗({attempt + 1}回目): {e}", file=sys.stderr)
            time.sleep(20)
    raise RuntimeError(f"判定結果を取得できませんでした: {last_error}")


def fmt(value, suffix="", digits=None):
    if value is None:
        return "—"
    if digits is not None:
        value = round(value, digits)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value:,}{suffix}" if isinstance(value, int) else f"{value}{suffix}"


def build_mail(result):
    today = datetime.now(JST)
    date_label = f"{today.month}/{today.day}"
    matches = result.get("matches", [])
    coverage = result.get("coverage", {})
    screened = coverage.get("screened") or 0
    total = coverage.get("totalListed") or 0
    c = result.get("criteria", {})

    if matches:
        subject = f"【高配当ボード】{date_label} 条件を満たす銘柄: {len(matches)}件"
    else:
        subject = f"【高配当ボード】{date_label} 該当銘柄なし"

    notes = []
    if total and screened < total * COVERAGE_WARNING_RATIO:
        notes.append(
            f"サーバー再起動直後のため、判定できたのは {screened:,} / {total:,} 銘柄のみです。"
            "残りは次回以降に判定されます。"
        )

    criteria_lines = [
        f"配当利回り {c.get('minYieldPct')}%以上",
        "EPSが5年前より増加",
        f"PER {c.get('maxPer')}倍以下 または 業界上位{c.get('industryTopN')}社平均以下",
        f"ROE {c.get('minRoe')}%以上 / ROA {c.get('minRoa')}%以上 / ROIC {c.get('minRoic')}%以上(近似)",
        f"配当性向 {c.get('maxPayoutRatio')}%以下",
        f"◎ = PBR {c.get('goodPbr', 1):.2f}倍以下",
    ]
    not_checked = result.get("notChecked", [])

    # --- テキスト版 ---
    text = [subject, ""]
    text += notes
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
                f"配当性向 {fmt(m.get('payoutRatio'), '%')} / EPS {fmt(eps_from.get('eps'), '円', 1)}({eps_from.get('year', '?')}年)→{fmt(m.get('eps'), '円', 1)}"
            )
            text.append("")
    else:
        text.append("今日は全条件を満たす銘柄はありませんでした。")
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
        f"<th {th}>ROE/ROA/ROIC</th><th {th}>配当性向</th><th {th}>EPS</th></tr>"
        + "".join(rows)
        + "</table>"
        if matches
        else "<p>今日は全条件を満たす銘柄はありませんでした。</p>"
    )
    notes_html = "".join(f"<p style='color:#b45309'>⚠️ {esc(n)}</p>" for n in notes)
    criteria_html = "".join(f"<li>{esc(line)}</li>" for line in criteria_lines)
    criteria_html += "".join(f"<li>判定していない条件: {esc(n)}</li>" for n in not_checked)
    body_html = (
        "<div style='font-family:sans-serif;color:#222;max-width:760px'>"
        f"<h2 style='font-size:18px'>{esc(subject)}</h2>"
        f"{notes_html}{table}"
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
    result = fetch_screening()
    subject, text, body_html = build_mail(result)
    if os.environ.get("DRY_RUN") == "1":
        with open("mail_preview.html", "w", encoding="utf-8") as f:
            f.write(body_html)
        print(text)
        return
    send(subject, text, body_html)


if __name__ == "__main__":
    main()
