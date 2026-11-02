"""Compare the app's indicators with TA-Lib (and independent TradingView-formula versions) on identical data."""
import json, sys
import numpy as np, talib

d = json.load(open(sys.argv[1]))
c = d['candles']; o = {k: np.array([np.nan if x is None else x for x in v], float) for k, v in d['out'].items()}
O = np.array([x['o'] for x in c], float); H = np.array([x['h'] for x in c], float); L = np.array([x['l'] for x in c], float)
C = np.array([x['c'] for x in c], float); V = np.array([x['v'] for x in c], float); T = np.array([x['t'] for x in c], np.int64)
n = len(C); W = slice(400, n)  # compare after warm-up (seeds differ, values converge)
fails = 0
def check(name, mine, ref, tol=1e-7, sl=W):
    global fails
    a, b = np.asarray(mine, float)[sl], np.asarray(ref, float)[sl]
    m = ~np.isnan(a) & ~np.isnan(b)
    both_nan_ok = np.array_equal(np.isnan(a), np.isnan(b))
    err = np.max(np.abs(a[m] - b[m]) / np.maximum(1.0, np.abs(b[m]))) if m.any() else np.inf
    good = m.sum() > 100 and err < tol and both_nan_ok
    print(f"{'PASS' if good else 'FAIL'}  {name:<28} max rel diff {err:.2e} over {m.sum()} bars" + ('' if both_nan_ok else '  (NaN mismatch)'))
    if not good: fails += 1

def roll(f, x, n_):
    out = np.full(len(x), np.nan)
    for i in range(n_ - 1, len(x)): out[i] = f(x[i - n_ + 1:i + 1])
    return out
sma = lambda x, n_: roll(np.mean, x, n_)

check('SMA 20', o['sma20'], talib.SMA(C, 20))
check('EMA 9', o['ema9'], talib.EMA(C, 9))
check('EMA 200', o['ema200'], talib.EMA(C, 200))
check('WMA 20', o['wma20'], talib.WMA(C, 20))
u, m_, l = talib.BBANDS(C, 20, 2, 2, 0)
check('Bollinger upper', o['bb.upper'], u); check('Bollinger basis', o['bb.basis'], m_); check('Bollinger lower', o['bb.lower'], l)
check('RSI 14', o['rsi14'], talib.RSI(C, 14))
mc, ms, mh = talib.MACD(C, 12, 26, 9)
check('MACD line', o['macd.macd'], mc); check('MACD signal', o['macd.signal'], ms); check('MACD histogram', o['macd.hist'], mh)
sk, sd = talib.STOCH(H, L, C, fastk_period=14, slowk_period=1, slowk_matype=0, slowd_period=3, slowd_matype=0)
check('Stochastic %K', o['stoch.k'], sk); check('Stochastic %D', o['stoch.d'], sd)
fk, fd = talib.STOCHRSI(C, timeperiod=14, fastk_period=14, fastd_period=3, fastd_matype=0)
check('Stoch RSI K', o['stochrsi.k'], fd); check('Stoch RSI D', o['stochrsi.d'], talib.SMA(fd, 3))
check('ATR 14', o['atr14'], talib.ATR(H, L, C, 14))
check('DMI +DI', o['dmi.plus'], talib.PLUS_DI(H, L, C, 14)); check('DMI -DI', o['dmi.minus'], talib.MINUS_DI(H, L, C, 14))
check('ADX 14', o['dmi.adx'], talib.ADX(H, L, C, 14))
ob = talib.OBV(C, V); check('OBV (same up to start offset)', o['obv.obv'], ob - ob[0])
check('CCI 20', o['cci.cci'], talib.CCI(H, L, C, 20), tol=1e-6)
check('Williams %R 14', o['wr.r'], talib.WILLR(H, L, C, 14))
check('MFI 14', o['mfi.mfi'], talib.MFI(H, L, C, V, 14))
# Parabolic SAR: TradingView's published reference (Pine) re-implemented independently here.
# (TA-Lib handles reversal bars slightly differently, so it is only reported for information.)
def tv_sar(st, inc, mx):
    res = np.full(n, np.nan); r = mm = acc = None; below = False
    for i in range(1, n):
        first = False
        if i == 1:
            below = C[1] > C[0]; mm = H[1] if below else L[1]; r = L[0] if below else H[0]; first = True; acc = st
        r = r + acc * (mm - r)
        if below and r > L[i]: first, below, r, mm, acc = True, False, max(H[i], mm), L[i], st
        elif (not below) and r < H[i]: first, below, r, mm, acc = True, True, min(L[i], mm), H[i], st
        if not first:
            if below and H[i] > mm: mm = H[i]; acc = min(acc + inc, mx)
            elif (not below) and L[i] < mm: mm = L[i]; acc = min(acc + inc, mx)
        if below: r = min(r, L[i - 1], L[i - 2] if i > 1 else np.inf)
        else: r = max(r, H[i - 1], H[i - 2] if i > 1 else -np.inf)
        res[i] = r
    return res
check('Parabolic SAR (TradingView)', o['sar.sar'], tv_sar(0.02, 0.02, 0.2), sl=slice(0, n))
ref = talib.SAR(H, L, 0.02, 0.2); a = o['sar.sar'][600:]; b = ref[600:]
print(f"      info: same side of price as TA-Lib SAR on {np.mean((a < C[600:]) == (b < C[600:])) * 100:.1f}% of bars")

# ---- independent versions of TradingView's published Pine formulas ----
def rma(x, n_):
    out = np.full(len(x), np.nan); s = None; buf = []
    for i, v in enumerate(x):
        if np.isnan(v): continue
        if s is None:
            buf.append(v)
            if len(buf) == n_: s = np.mean(buf); out[i] = s
        else:
            s = (s * (n_ - 1) + v) / n_; out[i] = s
    return out
tr = np.maximum.reduce([H - L, np.abs(H - np.roll(C, 1)), np.abs(L - np.roll(C, 1))]); tr[0] = H[0] - L[0]
atr10 = rma(tr, 10)
src = (H + L) / 2
up_b = src + 3 * atr10; lo_b = src - 3 * atr10
ST = np.full(n, np.nan); DIR = np.full(n, np.nan); pu = pl = pst = 0.0
for i in range(n):
    if np.isnan(atr10[i]): continue
    lo = lo_b[i] if (lo_b[i] > pl or C[i - 1] < pl) else pl
    up = up_b[i] if (up_b[i] < pu or C[i - 1] > pu) else pu
    if i == 0 or np.isnan(atr10[i - 1]): dr = 1
    elif pst == pu: dr = -1 if C[i] > up else 1
    else: dr = 1 if C[i] < lo else -1
    st = lo if dr == -1 else up
    ST[i], DIR[i] = st, dr; pu, pl, pst = up, lo, st
check('Supertrend line', o['st.line'], ST, sl=slice(10, n)); check('Supertrend direction', o['st.dir'], DIR, sl=slice(10, n))
day = T // 86_400_000; tp = (H + L + C) / 3; VW = np.zeros(n)
for dd in np.unique(day):
    idx = day == dd; VW[idx] = np.cumsum(tp[idx] * V[idx]) / np.cumsum(V[idx])
check('VWAP (daily session)', o['vwap.vwap'], VW, sl=slice(0, n))
dmid = lambda n_: (roll(np.max, H, n_) + roll(np.min, L, n_)) / 2
check('Ichimoku conversion', o['ichi.tenkan'], dmid(9), sl=slice(0, n)); check('Ichimoku base', o['ichi.kijun'], dmid(26), sl=slice(0, n))
check('Ichimoku span A', o['ichi.spanA'], (dmid(9) + dmid(26)) / 2, sl=slice(0, n)); check('Ichimoku span B', o['ichi.spanB'], dmid(52), sl=slice(0, n))
check('Donchian upper', o['don.upper'], roll(np.max, H, 20), sl=slice(0, n)); check('Donchian lower', o['don.lower'], roll(np.min, L, 20), sl=slice(0, n))
kb = talib.EMA(C, 20); check('Keltner basis', o['kc.basis'], kb); check('Keltner upper', o['kc.upper'], kb + 2 * atr10); check('Keltner lower', o['kc.lower'], kb - 2 * atr10)
print(f"\n{'All indicator checks passed' if fails == 0 else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
