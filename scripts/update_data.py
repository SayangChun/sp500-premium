#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
标普500场内基金「真实溢价率」数据抓取与估值计算
================================================
跟踪范围：仅标普500指数（剔除信息科技/生物科技/医疗保健等行业衍生品）。

数据源（全部公开免费）：
  1. 东方财富 push2      —— 场内实时行情（价/涨跌/成交额/时间戳）
  2. 天天基金 fundmobapi —— 官方单位净值（T-1 或 T-2 公布）
  3. Yahoo Finance       —— E-mini S&P 500 期货实时价与日线、USD/CNY 实时价与日线
  4. 东方财富 kline      —— 标普500现货指数最近收盘
  5. HaoETF              —— 交叉对照（它的「实时估值」同样基于实时期货修正）

口径（与前端 assets/app.js 保持一致）：
  估算净值 = 最新净值
             × (1 + (期货现价 / 净值日期货日收盘 - 1) × 仓位)
             × (1 + 汇率变动，汇率现价 / 净值日汇率收盘 - 1)
  真实溢价率 = 场内现价 / 估算净值 - 1        ← 剔除中美时段错位后的口径
  未修正溢价 = 场内现价 / 最新净值 - 1        ← 券商App常见的 T-1 滞后口径
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BJT = timezone(timedelta(hours=8))
ET = timezone(timedelta(hours=-4))  # 10月为 EDT
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "sp500.json"

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}

# 仅保留标普500指数基金（跟踪基准均为「标普500指数」）
FUNDS = [
    {"code": "513500", "name": "标普500ETF博时", "company": "博时基金", "market": "SH", "secid": "1.513500"},
    {"code": "159612", "name": "标普500ETF国泰", "company": "国泰基金", "market": "SZ", "secid": "0.159612"},
    {"code": "159655", "name": "标普500ETF华夏", "company": "华夏基金", "market": "SZ", "secid": "0.159655"},
    {"code": "513650", "name": "标普500ETF南方", "company": "南方基金", "market": "SH", "secid": "1.513650"},
    {"code": "161125", "name": "标普500LOF易方达", "company": "易方达基金", "market": "SZ", "secid": "0.161125"},
]

POSITION_DEFAULT = 0.95  # 仓位（HaoETF 移动平均估算约95%，可调）


def log(msg):
    print(f"[{datetime.now(BJT).strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def get(url, headers=None, timeout=20, retries=2, pause=1.5, force_curl=False):
    h = dict(UA)
    if headers:
        h.update(headers)
    last = None
    if not force_curl:
        for i in range(retries + 1):
            try:
                req = urllib.request.Request(url, headers=h)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return r.read()
            except Exception as e:  # noqa: BLE001
                last = e
                if i < retries:
                    time.sleep(pause)
    # 部分机房/代理会按 TLS 指纹拦截 Python（或被限流），回退 curl（GitHub Actions 与 Git Bash 均自带）
    try:
        import subprocess
        cmd = ["curl", "-sS", "--max-time", str(timeout), "-A", UA["User-Agent"]]
        for k, v in (headers or {}).items():
            cmd += ["-H", f"{k}: {v}"]
        cmd.append(url)
        out = subprocess.run(cmd, capture_output=True, timeout=timeout + 10).stdout
        if out:
            return out
    except Exception as e:  # noqa: BLE001
        last = e
    log(f"GET失败 {url[:90]} -> {last}")
    return None


def get_json(url, **kw):
    raw = get(url, **kw)
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        log(f"JSON解析失败 {url[:60]}: {e}")
        return None


# ---------------------------------------------------------------- 行情/净值/期货
def fetch_quotes():
    """东方财富 push2 批量实时行情；失败回退腾讯 qt.gtimg.cn（两者均支持浏览器跨域）"""
    secids = ",".join(f["secid"] for f in FUNDS)
    url = (
        "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2"
        f"&secids={secids}&fields=f1,f2,f3,f4,f12,f13,f14,f18,f48,f86,f124"
    )
    out = {}
    js = get_json(url)
    if js and js.get("data"):
        for d in js["data"]["diff"]:
            code = str(d.get("f12", ""))
            out[code] = {
                "price": d.get("f2"),
                "chg_pct": (d.get("f4") or 0) / 100.0,
                "prev_close": d.get("f18"),
                "amount": d.get("f48"),
                "turnover_pct": d.get("f8"),
                "quote_time": bjt_str(d.get("f124")),
                "source": "push2",
            }
    tq = fetch_quotes_tencent()
    for code, v in tq.items():
        if code not in out:
            out[code] = v
        else:  # push2 不含净值，用腾讯的净值字段补齐
            for k in ("nav", "nav_chg_pct"):
                if out[code].get(k) is None:
                    out[code][k] = v.get(k)
    return out


def fetch_quotes_tencent():
    qs = ",".join(f"{'sh' if f['market'] == 'SH' else 'sz'}{f['code']}" for f in FUNDS)
    raw = get(f"https://qt.gtimg.cn/q={qs}")
    out = {}
    if not raw:
        return out
    for m in re.finditer(r'v_(s[hz]\w+)="([^"]*)"', raw.decode("utf-8", "replace")):
        code = m.group(1)[2:]
        arr = m.group(2).split("~")
        if len(arr) < 33 or not arr[3]:
            continue
        out[code] = {
            "price": num(arr[3]),
            "prev_close": num(arr[4]),
            "chg_pct": num(arr[32]),
            "amount": (num(arr[37]) * 10000) if num(arr[37]) else None,
            "turnover_pct": num(arr[38]),
            "quote_time": tencent_time(arr[30]),
            "nav": num(arr[81]) if len(arr) > 81 else None,
            "nav_chg_pct": num(arr[80]) if len(arr) > 80 else None,
            "source": "tencent",
        }
    return out


def tencent_time(s):
    s = re.sub(r"\D", "", str(s or ""))
    if len(s) == 14:
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]} {s[8:10]}:{s[10:12]}:{s[12:14]}"
    return s or None


_last_req = 0.0


def throttled_get(url, **kw):
    """同一出口对天天基金接口有频率限制，请求间保持 ≥1.2s 间隔"""
    global _last_req
    dt = time.time() - _last_req
    if dt < 2.5:
        time.sleep(2.5 - dt)
    _last_req = time.time()
    return get(url, **kw)


def fetch_nav_history(code, size=40):
    """基金净值历史 [(日期, 单位净值, 日涨跌%), ...] 最新在前。
    首选 pingzhongdata（一次请求拿全量历史）；失败回退 fundmobapi 移动端接口。"""
    raw = throttled_get(f"https://fund.eastmoney.com/pingzhongdata/{code}.js",
                        headers={"Referer": f"https://fund.eastmoney.com/{code}.html"}, pause=2.0)
    if raw:
        m = re.search(rb"Data_netWorthTrend\s*=\s*(\[.*?\]);", raw, re.S)
        if m:
            try:
                data = json.loads(m.group(1).decode("utf-8"))
                out = []
                for d in data[-size:]:
                    ts, nav_v = d.get("x"), d.get("y")
                    if ts is None or nav_v is None:
                        continue
                    er = d.get("equityReturn")
                    out.append((datetime.fromtimestamp(ts / 1000, BJT).strftime("%Y-%m-%d"),
                                float(nav_v),
                                None if er in (None, "", "--") else float(er)))
                if out:
                    return list(reversed(out))  # 统一为「最新在前」
            except Exception as e:  # noqa: BLE001
                log(f"pingzhongdata 解析失败 {code}: {e}")
    url = (
        "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList"
        f"?FCODE={code}&pageIndex=1&pageSize={size}&deviceid=1&plat=Android"
        f"&product=EFund&version=6.2.8&appType=ttjj"
    )
    for attempt in range(2):
        js = get_json(throttled_get(url, pause=2.5), retries=0)
        if not js or not js.get("Datas"):
            js = get_json(get(url, force_curl=True, pause=2.5), retries=0)
        if js and js.get("Datas"):
            out = []
            for d in js["Datas"]:
                try:
                    out.append((d["FSRQ"], float(d["DWJZ"]),
                                None if d.get("JZZZL") in (None, "", "--") else float(d["JZZZL"])))
                except (KeyError, TypeError, ValueError):
                    continue
            if out:
                return out
        time.sleep(3.0 * (attempt + 1))
    return []


def estimate_position(nav_hist, spx_klines, threshold=0.005, window=40, min_points=6):
    """用「净值日涨跌 vs 标普500日涨跌」滚动回归（带截距 OLS，斜率即实际持仓）。
    nav_hist 涨跌幅缺失时用相邻净值比值回算。
    经验参数：只取指数波动 ≥0.5% 的交易日——小波动日的比值被管理费/汇兑/申赎冲击
    污染严重（实测 ≥0.3% 阈值斜率被压到 0.87，≥0.5% 为 0.933，≥0.8% 为 0.96，
    R² 随阈值升高到 0.99，与 HaoETF 移动平均估算的 94~95% 互证）。"""
    closes = dict(spx_klines)
    dates = sorted(closes)
    spx_chg = {}
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        if closes.get(d0):
            spx_chg[d1] = closes[d1] / closes[d0] - 1
    hist = sorted(nav_hist, key=lambda x: x[0])
    chgs = {}
    for i in range(1, len(hist)):
        d0, n0, c0 = hist[i - 1]
        d1, n1, c1 = hist[i]
        if c1 is not None:
            chgs[d1] = c1 / 100.0
        elif n0:
            chgs[d1] = n1 / n0 - 1
    pts = [(spx_chg[d], chgs[d]) for d in sorted(chgs)
           if d in spx_chg and abs(spx_chg[d]) >= threshold][-window:]
    n = len(pts)
    if n < min_points:
        return None, n
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx <= 0:
        return None, n
    b = sxy / sxx
    return round(min(max(b, 0.85), 1.02), 4), n


def yahoo(symbol, range_="1d", interval="1m"):
    return get_json(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?range={range_}&interval={interval}"
    )


def yahoo_quote(symbol):
    """实时报价 + 日线收盘（ET 日期 -> 收盘价）"""
    q = yahoo(symbol, "1d", "1m")
    d = yahoo(symbol, "5d", "1d")
    price = chg = ts = None
    daily = {}
    if q and q.get("chart", {}).get("result"):
        m = q["chart"]["result"][0]["meta"]
        price = m.get("regularMarketPrice")
        chg = m.get("regularMarketChangePercent")
        ts = m.get("regularMarketTime")
    if d and d.get("chart", {}).get("result"):
        r = d["chart"]["result"][0]
        closes = r.get("indicators", {}).get("quote", [{}])[0].get("close") or []
        for t, c in zip(r.get("timestamp") or [], closes):
            if c is None:
                continue
            daily[datetime.fromtimestamp(t, ET).strftime("%Y-%m-%d")] = round(float(c), 4)
    return {"price": price, "chg_pct": chg, "time": bjt_str(ts), "daily": daily}


def fetch_spx_klines(limit=35):
    """标普500现货日线（东财，secid=100.SPX，按美东日期）→ [(date, close), ...]
    该接口对连续请求限流（实测成功率约60%），需独立退避重试；仍失败则由调用方沿用上次快照。"""
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.SPX"
        "&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=0&end=20500101&lmt=%d" % limit
    )
    for attempt in range(4):
        js = get_json(url, retries=1, pause=1.5)
        out = []
        if js and js.get("data", {}).get("klines"):
            for line in js["data"]["klines"]:
                date, close = line.split(",")
                out.append((date, float(close)))
            if out:
                return out
        time.sleep(2.5 * (attempt + 1))
    return []


# ---------------------------------------------------------------- HaoETF 对照
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S | re.I)
TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(s):
    return TAG_RE.sub("", s).replace("&nbsp;", " ").strip()


def num(s):
    try:
        return float(str(s).replace("%", "").replace(",", ""))
    except (TypeError, ValueError):
        return None


def fetch_haoetf(code):
    """抓取 HaoETF 单基金页，解析实时估值/实时溢价/T-1口径/申购限额（失败不影响主流程）"""
    raw = get(f"https://www.haoetf.com/qdii/{code}", retries=1, timeout=25)
    if not raw:
        return None
    try:
        html = raw.decode("utf-8", "replace")
        upd = re.search(r"数据更新时间[：:]\s*([0-9\-:\s]+)", html)
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I)
        row = None
        for r in rows:
            if re.search(r">{}</a>|>{}</td>|<td[^>]*>{}\s*<".format(code, code, code), r):
                row = r
                break
        if row is None:
            for r in rows:
                if code in strip_tags(r):
                    row = r
                    break
        if row is None:
            return None
        cells = [strip_tags(c) for c in CELL_RE.findall(row)]
        if len(cells) < 13 or cells[0].strip() != code:
            return None
        nav_date = None
        for c in cells[13:15]:
            # 页面上日期为短格式，如 10-12 或 2026-10-12
            if c and re.match(r"^(20\d\d-)?\d{1,2}-\d{1,2}$", c):
                nav_date = c if "-" in c[:4] or len(c) > 5 else nav_date
                if re.match(r"^\d{1,2}-\d{1,2}$", c):
                    nav_date = f"{datetime.now(BJT).year}-{c}"
                else:
                    nav_date = c
                break
        out = {
            "est_nav": num(cells[2]),
            "premium_pct": num(cells[3]),
            "t1_est_nav": num(cells[4]),
            "t1_premium_pct": num(cells[5]),
            "price": num(cells[7]),
            "chg_pct": num(cells[8]),
            "amount": num(cells[9]),
            "nav": num(cells[12]),
            "nav_date": nav_date,
            "quota": None,
            "updated": (upd.group(1).strip() if upd else None),
        }
        for c in cells[13:]:  # 申购限额形如「暂停申购 / 1000元 / 无限制 / 0.5%」
            if c and re.search(r"暂停申购|无限制|^\d+(元|万)|限额", c):
                out["quota"] = c
                break
        # 历史数据表按日期倒序；第 i 行的「T-1日净值」对应的是下一行(row_dates[i+1])的交易日
        # （row 10-14 的 T-1 净值 = 10-13 的 NAV），据此还原 NAV 的真实日期
        for i in range(len(row_dates) - 1):
            cells_h = row_dates[i][1]
            nv_v = num(cells_h[2])
            if nv_v is not None:
                nav_hist.append((row_dates[i + 1][0], nv_v, None))
            if re.match(r"^\d+(\.\d+)?%$", cells_h[-1] or ""):
                out["position"] = float(cells_h[-1][:-1])
        out["nav_hist"] = nav_hist
        return out
    except Exception as e:  # noqa: BLE001
        log(f"HaoETF解析失败 {code}: {e}")
        return None


# ---------------------------------------------------------------- 估值计算
def clamp(x, lo=-0.005, hi=0.005):
    return max(lo, min(hi, x))


def pick_ref(daily, nav_date):
    """取净值日期当天的期货/汇率收盘；遇休市取更早最近的 bar"""
    if nav_date in daily:
        return daily[nav_date], nav_date
    earlier = [d for d in sorted(daily) if d < (nav_date or "")]
    return (daily[earlier[-1]], earlier[-1]) if earlier else (None, None)


def load_prev():
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def tencent_es_quote():
    """腾讯 hf_ES 实时快照（Yahoo 不可用时的第一兜底）"""
    raw = get("https://qt.gtimg.cn/q=hf_ES")
    if not raw:
        return None
    m = re.search(r'v_hf_ES="([^"]*)"', raw.decode("utf-8", "replace"))
    if not m:
        return None
    a = m.group(1).split(",")
    if len(a) < 8 or not a[0]:
        return None
    return {"price": num(a[0]), "chg_pct": num(a[1]),
            "time": (f"{a[12]} {a[6]}" if len(a) > 12 else a[6]), "prev_close": num(a[7])}


def build():
    prev = load_prev()
    prev_dates = {f.get("code"): f.get("nav_date") for f in prev.get("funds", [])}
    log("抓取场内行情（东方财富→腾讯）…")
    quotes = fetch_quotes()
    log("抓取 ES 期货实时价（腾讯 hf_ES 优先，Yahoo 兜底）…")
    tq = tencent_es_quote()
    es_price = es_prev = es_chg = es_time = None
    es_src = "tencent" if tq else "none"
    if tq:
        es_price, es_prev, es_chg, es_time = tq["price"], tq["prev_close"], tq["chg_pct"], tq["time"]
    else:
        yq = yahoo_quote("ES=F")
        if yq.get("price"):
            es_price, es_chg, es_time, es_src = yq["price"], yq["chg_pct"], yq.get("time"), "yahoo"
        else:
            es_price = (prev.get("market", {}).get("es_futures") or {}).get("price")
            es_src = "snapshot"
    log("抓取汇率（Yahoo，失败则按 0 变动）…")
    fx = yahoo_quote("CNY=X")
    fx_price, fx_src = fx.get("price"), ("Yahoo" if fx.get("price") else "none")
    if not fx_price:
        fx_price = (prev.get("market", {}).get("fx") or {}).get("price")
        fx_src = fx_src if fx_price else "snapshot"
    log("抓取标普500现货日线（东方财富）…")
    spx_klines = fetch_spx_klines()
    if not spx_klines:  # 限流等瞬时失败时沿用上次快照的日线（隔夜段锚点）
        prev_spx = (prev.get("market", {}).get("spx_klines") or {})
        spx_klines = sorted(((d, float(c)) for d, c in prev_spx.items()))
    spx_map = dict(spx_klines)
    spx_last_date, spx_last_close = spx_klines[-1] if spx_klines else (None, None)

    funds = []
    for f in FUNDS:
        q = quotes.get(f["code"], {})
        log(f"  {f['code']} {f['name']}…")
        hao = fetch_haoetf(f["code"])
        if not hao:  # HaoETF 瞬时失败时补一次
            time.sleep(4)
            hao = fetch_haoetf(f["code"])
        nv_hist = fetch_nav_history(f["code"])
        nav_src = "fundmobapi"
        nv = None
        if nv_hist:
            nv = {"nav": nv_hist[0][1], "nav_date": nv_hist[0][0], "nav_chg_pct": nv_hist[0][2]}
        if not nv and q.get("nav"):  # fundmobapi 被限流时用腾讯净值字段，日期取 HaoETF/上次快照
            nv = {"nav": q.get("nav"),
                  "nav_date": (hao or {}).get("nav_date") or prev_dates.get(f["code"]),
                  "nav_chg_pct": q.get("nav_chg_pct")}
            nav_src = "tencent"
        if not nv and hao and hao.get("nav"):
            nv = {"nav": hao["nav"], "nav_date": hao["nav_date"], "nav_chg_pct": None}
            nav_src = "haoetf"
        nav = nv["nav"] if nv else None
        nav_date = nv["nav_date"] if nv else None
        # 仓位：净值涨跌 vs 指数涨跌 的滚动回归估算（无人工输入）；依次兜底
        pos, pos_n = estimate_position(nv_hist, spx_klines)
        pos_method = "rolling_ols"
        if pos is None and hao and hao.get("nav_hist"):
            pos, pos_n = estimate_position(hao["nav_hist"], spx_klines)
            pos_method = "rolling_ols"
        if pos is None and hao and hao.get("position"):
            pos, pos_method, pos_n = hao["position"] / 100.0, "haoetf_est", None
        if pos is None:
            pos, pos_method, pos_n = POSITION_DEFAULT, "default", None
        # 行情优先东财/腾讯；都被限流时退回 HaoETF 行内自带的现价
        price = q.get("price") if q.get("price") else (hao or {}).get("price")
        chg_pct = q.get("chg_pct") if q.get("chg_pct") is not None else (hao or {}).get("chg_pct")
        amount = q.get("amount") or (hao or {}).get("amount")
        quote_time = q.get("quote_time") or (hao or {}).get("updated")
        # 两段式指数变动：①隔夜段（净值日→最近美股收盘，标普现货日线）②今日段（期货实时÷昨结）
        r_idx = r_idx_parts = None
        if es_price and nav_date and spx_map.get(nav_date) and spx_last_close:
            overnight = spx_last_close / spx_map[nav_date] - 1
            today = (es_price / es_prev - 1) if es_prev else 0.0
            r_idx = overnight + today
            r_idx_parts = {"overnight": round(overnight * 100, 3), "today": round(today * 100, 3)}
        r_fx = 0.0  # 汇率日内变动极小，且 Yahoo 有时不可达；有值时也钳制在 ±0.5%
        if fx_price and nav_date and (fx.get("daily") or {}).get(nav_date):
            r_fx = clamp(fx_price / fx["daily"][nav_date] - 1)
        est = prem = None
        if nav and price and r_idx is not None:
            est = nav * (1 + r_idx * pos) * (1 + r_fx)
            prem = (price / est - 1) * 100
        funds.append({
            **f,
            "price": price,
            "chg_pct": chg_pct,
            "amount": amount,
            "quote_time": quote_time,
            "quote_source": q.get("source") or ("haoetf" if price else None),
            "nav_source": nav_src,
            "nav": nav,
            "nav_date": nav_date,
            "nav_chg_pct": nv.get("nav_chg_pct") if nv else None,
            "position": pos,
            "position_method": pos_method,
            "position_points": pos_n,
            "r_idx_parts": r_idx_parts,
            "est_nav": round(est, 4) if est else None,
            "premium_pct": round(prem, 2) if prem is not None else None,
            "naive_premium_pct": round((price / nav - 1) * 100, 2) if (price and nav) else None,
            "haoetf": hao,
        })

    data = {
        "generated_at": datetime.now(BJT).strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "scope": "仅跟踪标普500指数（剔除行业/主题衍生品）",
        "config": {
            "position_default": POSITION_DEFAULT,
            "formula": "r_idx = (标普现货最近收盘/净值日收盘 − 1) + (ES期货实时/期货昨结 − 1)；"
                       "est_nav = nav × (1 + r_idx × 仓位) × (1 + Δ汇率)；premium = 现价 / est_nav − 1",
        },
        "market": {
            "es_futures": {"name": "E-mini S&P 500（12月）", "source": es_src,
                           "price": es_price, "prev_close": es_prev,
                           "chg_pct": es_chg, "time": es_time},
            "fx": {"name": "USD/CNY", "source": fx_src, "price": fx_price,
                   "time": fx.get("time")},
            "spx_klines": spx_map,
            "spx_last": {"date": spx_last_date, "close": spx_last_close},
        },
        "funds": funds,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"已写出 {OUT}")
    return data


def bjt_str(ts):
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts), BJT).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    d = build()
    print(f"\n生成时间: {d['generated_at']}")
    m = d["market"]
    print(f"ES期货 {m['es_futures']['price']} ({m['es_futures']['source']})  "
          f"USD/CNY {m['fx']['price']}  SPX收盘 {m['spx_last']}")
    print(f"{'代码':<8}{'名称':<14}{'现价':>7}{'净值':>8}{'估算净值':>9}{'真实溢价':>9}  对照(HaoETF)")
    for f in d["funds"]:
        h = f.get("haoetf") or {}
        hs = f"{h.get('premium_pct')}%" if h.get("premium_pct") is not None else "—"
        print(f"{f['code']:<8}{f['name']:<14}{f['price']!s:>7}{f['nav']!s:>8}"
              f"{f['est_nav']!s:>9}{f['premium_pct']!s:>8}%  {hs}")
