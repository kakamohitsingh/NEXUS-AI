"""
ai_service.py — Nexus AI v3.0 — World-Class Prediction Engine
==============================================================
Uses a real scikit-learn GradientBoostingRegressor trained on
live CoinGecko 14-day hourly price data with 16 engineered features.
Falls back gracefully to EMA/RSI simulation if ML is unavailable.
"""

import math
import logging
import hashlib
import random
from datetime import datetime, timezone
from typing import Any, Optional

log = logging.getLogger("nexus-ai")

# ─── ASSET METADATA (10 coins) ───────────────────────────────────────────────
ASSET_METADATA: dict[str, dict] = {
    "bitcoin":     {"id": "btc",  "name": "Bitcoin",   "symbol": "BTC",  "logo_class": "asset-logo--btc",  "dot_class": "asset-dot--btc",  "logo_label": "₿"},
    "ethereum":    {"id": "eth",  "name": "Ethereum",  "symbol": "ETH",  "logo_class": "asset-logo--eth",  "dot_class": "asset-dot--eth",  "logo_label": "Ξ"},
    "solana":      {"id": "sol",  "name": "Solana",    "symbol": "SOL",  "logo_class": "asset-logo--sol",  "dot_class": "asset-dot--sol",  "logo_label": "◎"},
    "binancecoin": {"id": "bnb",  "name": "BNB",       "symbol": "BNB",  "logo_class": "asset-logo--bnb",  "dot_class": "asset-dot--bnb",  "logo_label": "BNB"},
    "ripple":      {"id": "xrp",  "name": "XRP",       "symbol": "XRP",  "logo_class": "asset-logo--xrp",  "dot_class": "asset-dot--xrp",  "logo_label": "XRP"},
    "dogecoin":    {"id": "doge", "name": "Dogecoin",  "symbol": "DOGE", "logo_class": "asset-logo--doge", "dot_class": "asset-dot--doge", "logo_label": "Ð"},
    "cardano":     {"id": "ada",  "name": "Cardano",   "symbol": "ADA",  "logo_class": "asset-logo--ada",  "dot_class": "asset-dot--ada",  "logo_label": "ADA"},
    "avalanche-2": {"id": "avax", "name": "Avalanche", "symbol": "AVAX", "logo_class": "asset-logo--avax", "dot_class": "asset-dot--avax", "logo_label": "AVAX"},
    "chainlink":   {"id": "link", "name": "Chainlink", "symbol": "LINK", "logo_class": "asset-logo--link", "dot_class": "asset-dot--link", "logo_label": "⬡"},
    "polkadot":    {"id": "dot",  "name": "Polkadot",  "symbol": "DOT",  "logo_class": "asset-logo--dot",  "dot_class": "asset-dot--dot",  "logo_label": "DOT"},
}

# ─── MODEL & HISTORY CACHE ───────────────────────────────────────────────────
MODEL_CACHE:     dict[str, Any]        = {}
HISTORICAL_CACHE: dict[str, list[float]] = {}

# ─── TECHNICAL INDICATOR HELPERS ─────────────────────────────────────────────

def _ema(prices: list[float], period: int) -> list[float]:
    k = 2.0 / (period + 1)
    out = [prices[0]]
    for p in prices[1:]:
        out.append(p * k + out[-1] * (1 - k))
    return out

def _rsi(prices: list[float], period: int = 14) -> float:
    if len(prices) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(prices)):
        d = prices[i] - prices[i - 1]
        gains.append(max(d, 0)); losses.append(max(-d, 0))
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    if al == 0: return 100.0
    return round(100 - 100 / (1 + ag / al), 2)

def _atr(prices: list[float], period: int = 14) -> float:
    if len(prices) < 2: return prices[0] * 0.01
    trs = [abs(prices[i] - prices[i - 1]) for i in range(1, len(prices))]
    return sum(trs[-period:]) / min(period, len(trs))

# ─── ML FEATURE ENGINEERING ──────────────────────────────────────────────────

def _build_features(prices: list[float]) -> "list[float]":
    """Build 16-element feature vector from recent price history."""
    try:
        import numpy as np
        p = np.array(prices[-50:], dtype=float)
        n = len(p)
        eps = 1e-10

        def ret(lag): return float((p[-1] - p[-1-lag]) / (p[-1-lag] + eps)) if n > lag else 0.0

        r1, r4, r12, r24 = ret(1), ret(4) if n>4 else ret(1), ret(12) if n>12 else ret(1), ret(24) if n>24 else ret(1)

        ema7  = _ema(list(p), min(7, n))[-1]
        ema21 = _ema(list(p), min(21, n))[-1]
        ema12 = _ema(list(p), min(12, n))[-1]
        ema26 = _ema(list(p), min(26, n))[-1]

        ema7_rel  = float((p[-1] - ema7)  / (p[-1] + eps))
        ema21_rel = float((p[-1] - ema21) / (p[-1] + eps))
        ema_cross = float((ema7 - ema21)  / (p[-1] + eps))
        macd      = float((ema12 - ema26) / (p[-1] + eps))

        rsi_n = _rsi(list(p), min(14, n-1)) / 100.0

        rets = np.diff(p) / (p[:-1] + eps)
        vol24 = float(np.std(rets[-24:])) if len(rets) >= 24 else float(np.std(rets) if len(rets) else 0)
        vol7d = float(np.std(rets)) if len(rets) > 1 else 0.0

        mom12 = float(np.mean(rets[-12:] > 0)) if len(rets) >= 12 else 0.5
        mom24 = float(np.mean(rets[-24:] > 0)) if len(rets) >= 24 else 0.5

        win = p[-20:] if n >= 20 else p
        bb_pos = float(np.clip((p[-1] - np.mean(win)) / (2 * np.std(win) + eps), -3, 3))

        h = datetime.now(timezone.utc).hour
        return [r1, r4, r12, r24, ema7_rel, ema21_rel, ema_cross, rsi_n,
                vol24, vol7d, mom12, mom24, macd, bb_pos,
                math.sin(2*math.pi*h/24), math.cos(2*math.pi*h/24)]
    except Exception:
        return [0.0] * 16

# ─── ML TRAINING ─────────────────────────────────────────────────────────────

def train_models(historical_data: dict[str, list[float]]) -> None:
    """Train one GradientBoostingRegressor per coin on real 14-day hourly data."""
    global HISTORICAL_CACHE
    HISTORICAL_CACHE = {k: list(v) for k, v in historical_data.items()}

    try:
        import numpy as np
        from sklearn.ensemble import GradientBoostingRegressor
    except ImportError:
        log.error("scikit-learn/numpy not installed — ML predictions unavailable")
        return

    for cg_id, prices in historical_data.items():
        if len(prices) < 60:
            log.warning("Skipping ML train for %s: only %d points", cg_id, len(prices))
            continue
        try:
            X, y = [], []
            for i in range(30, len(prices) - 1):
                feat = _build_features(prices[:i+1])
                nxt  = (prices[i+1] - prices[i]) / (prices[i] + 1e-10)
                X.append(feat); y.append(nxt)

            if len(X) < 20:
                continue

            X, y = np.array(X), np.array(y)
            model = GradientBoostingRegressor(
                n_estimators=200, learning_rate=0.06,
                max_depth=4, subsample=0.8,
                min_samples_leaf=3, random_state=42
            )
            model.fit(X, y)
            MODEL_CACHE[cg_id] = model
            log.info("✓ ML model trained: %-14s  samples=%d", cg_id, len(X))
        except Exception as exc:
            log.warning("ML train failed for %s: %s", cg_id, exc)

# ─── SIMULATION FALLBACK ─────────────────────────────────────────────────────

def _sim_series(base_price: float, symbol: str, n: int = 50) -> list[float]:
    """Generate synthetic price series seeded per-minute so targets change each broadcast."""
    now = datetime.now(timezone.utc)
    # Seed changes every minute — targets update every ~10s broadcast (same minute = same trend direction, slightly different magnitudes)
    seed = int(hashlib.md5(
        f"{symbol}{now.strftime('%Y%m%d%H%M')}".encode()
    ).hexdigest(), 16) % (2**32)
    rng = random.Random(seed)
    vol = base_price * 0.012  # slightly higher vol for more movement
    prices, price = [], base_price * (1 + rng.uniform(-0.06, 0.06))
    for _ in range(n):
        drift = (base_price - price) * 0.03 + rng.gauss(0, vol)
        price = max(price + drift, base_price * 0.4)
        prices.append(round(price, 8))
    prices[-1] = base_price
    return prices

def _sim_confidence(ema7, ema21, rsi, atr, price):
    ema_s = max(0, min(40, int((ema7[-1]-ema21[-1])/price*2000+20)))
    rsi_s = int(abs(rsi-50)/50*30)
    atr_s = max(0, int(30 - atr/price*3000))
    return max(55, min(96, ema_s+rsi_s+atr_s))

# ─── PUBLIC API ──────────────────────────────────────────────────────────────

def analyze_crypto_data(live_price_data: dict) -> list[dict]:
    """
    Generate predictions for all coins.
    Uses real GBR ML model when available; falls back to EMA/RSI simulation.
    """
    results: list[dict] = []

    for cg_id, meta in ASSET_METADATA.items():
        raw = live_price_data.get(cg_id)
        if not raw:
            continue
        current_price   = float(raw.get("usd", 0))
        price_change_24h = float(raw.get("usd_24h_change", 0))
        if current_price <= 0:
            continue

        decimals = 2 if current_price >= 10 else 4

        # ── Try ML prediction ─────────────────────────────────────────────
        ml_used = False
        model = MODEL_CACHE.get(cg_id)
        if model and cg_id in HISTORICAL_CACHE:
            try:
                prices = HISTORICAL_CACHE[cg_id] + [current_price]
                feat   = _build_features(prices)
                import numpy as np
                pred_ret = float(model.predict([feat])[0])
                pred_price = current_price * (1 + pred_ret)

                forecast_direction = "up" if pred_ret > 0 else "down"
                # Confidence: magnitude of predicted return scaled to 55-96
                confidence = int(min(96, max(55, 60 + abs(pred_ret) * 5000)))
                next_target = round(pred_price, decimals)
                ml_used = True
            except Exception as exc:
                log.debug("ML predict failed %s: %s", cg_id, exc)
                ml_used = False

        # ── EMA/RSI simulation fallback ───────────────────────────────────
        if not ml_used:
            prices = _sim_series(current_price, meta["symbol"])
            ema7   = _ema(prices, 7)
            ema21  = _ema(prices, 21)
            rsi    = _rsi(prices, 14)
            atr    = _atr(prices, 14)
            forecast_direction = "up" if ema7[-1] >= ema21[-1] else "down"
            confidence = _sim_confidence(ema7, ema21, rsi, atr, current_price)
            # Target: 1.5% to 4% move from current price based on ATR + momentum
            spread_pct = max(0.015, min(0.04, atr / current_price * 8))
            # Add per-minute jitter so target actually changes between broadcasts
            minute_jitter = (datetime.now(timezone.utc).minute % 10) * 0.002
            spread = current_price * (spread_pct + minute_jitter)
            if forecast_direction == "up":
                next_target = round(current_price + spread * (1 + max(0,(70-rsi)/70)), decimals)
            else:
                next_target = round(current_price - spread * (1 + max(0,(rsi-30)/70)), decimals)

        results.append({
            "id":                 meta["id"],
            "name":               meta["name"],
            "symbol":             meta["symbol"],
            "logo_class":         meta["logo_class"],
            "dot_class":          meta["dot_class"],
            "logo_label":         meta["logo_label"],
            "current_price":      round(current_price, decimals),
            "price_change_24h":   round(price_change_24h, 2),
            "forecast_direction": forecast_direction,
            "confidence_score":   confidence,
            "next_target_price":  next_target,
            "ml_powered":         ml_used,
        })

    return results
