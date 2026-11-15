"""Rebuild events.csv: a made-up portfolio priced at real Yahoo closes.

Run from the repo root (yfinance comes with the workspace):

    uv run python website/scripts/screenshots/build_fixture.py

Only needed when the fixture should move; capture.mjs reads the committed CSV.
Amounts are in EUR, the base currency: USD closes are converted at that day's
EURUSD close, as a broker debiting a euro account would.
"""
import csv
import math
from datetime import date, timedelta
from pathlib import Path

import yfinance as yf

OUT = Path(__file__).with_name('events.csv')
START, END = date(2023, 11, 1), date(2026, 11, 13)

NAMES = {
    'AAPL': 'Apple Inc.', 'MSFT': 'Microsoft Corporation', 'NVDA': 'NVIDIA Corporation',
    'CW8.PA': 'Amundi MSCI World UCITS ETF', 'ASML.AS': 'ASML Holding N.V.',
    'AI.PA': 'Air Liquide', 'TTE.PA': 'TotalEnergies SE', 'MC.PA': 'LVMH',
}
USD = {'AAPL', 'MSFT', 'NVDA'}
FEE = {'pea': 1.99, 'cto': 0.99, 'av': 0.0}

# (date, account, symbol, euros to spend) — NVDA only after its June 2024 split.
BUYS = [
    ('2023-11-16', 'pea', 'CW8.PA', 4000), ('2023-11-17', 'pea', 'AI.PA', 3000),
    ('2023-11-21', 'cto', 'AAPL', 3500), ('2023-11-22', 'cto', 'MSFT', 3500),
    ('2023-12-04', 'av', 'CW8.PA', 5000), ('2023-12-05', 'av', 'TTE.PA', 2500),
    ('2024-01-15', 'pea', 'TTE.PA', 2500), ('2024-03-12', 'pea', 'MC.PA', 2500),
    ('2024-06-04', 'pea', 'CW8.PA', 3000), ('2024-06-12', 'pea', 'ASML.AS', 2000),
    ('2024-07-15', 'cto', 'NVDA', 2500), ('2024-09-03', 'cto', 'AAPL', 2500),
    ('2024-09-04', 'cto', 'NVDA', 2500), ('2024-10-15', 'pea', 'CW8.PA', 1500),
    ('2024-12-03', 'av', 'CW8.PA', 4000), ('2025-01-07', 'pea', 'CW8.PA', 3000),
    ('2025-02-10', 'pea', 'TTE.PA', 1500), ('2025-04-15', 'pea', 'CW8.PA', 1500),
    ('2025-05-12', 'pea', 'AI.PA', 1500), ('2025-06-03', 'cto', 'AAPL', 2000),
    ('2025-06-04', 'cto', 'MSFT', 2500), ('2025-09-02', 'pea', 'CW8.PA', 2500),
    ('2025-10-14', 'pea', 'ASML.AS', 1500), ('2025-12-02', 'av', 'CW8.PA', 4000),
    ('2026-03-03', 'pea', 'CW8.PA', 2500), ('2026-05-05', 'cto', 'MSFT', 2500),
]
# (date, account, symbol, share of the position sold)
SELLS = [('2025-08-12', 'cto', 'NVDA', 0.4), ('2025-11-10', 'pea', 'MC.PA', 0.5),
         ('2026-06-30', 'cto', 'AAPL', 0.3)]
DEPOSITS = [
    ('2023-11-15', 'pea', 12500), ('2023-11-20', 'cto', 10000), ('2023-12-01', 'av', 8000),
    ('2024-06-03', 'pea', 5000), ('2024-09-02', 'cto', 5000), ('2024-12-02', 'av', 4000),
    ('2025-01-06', 'pea', 5000), ('2025-06-02', 'cto', 4500), ('2025-09-01', 'pea', 4000),
    ('2025-12-01', 'av', 4000), ('2026-03-02', 'pea', 2500), ('2026-05-04', 'cto', 2500),
]
WITHDRAWALS = [('2026-07-01', 'cto', 1500)]
# Dividends kept for the French lines of the PEA only, so the ledger stays readable.
PAYERS = {'AI.PA', 'TTE.PA', 'MC.PA'}


def history(symbol):
    frame = yf.Ticker(symbol).history(start=START.isoformat(), end=END.isoformat(),
                                      auto_adjust=False, actions=True)
    closes = {ts.date(): float(row['Close']) for ts, row in frame.iterrows()}
    dividends = {ts.date(): float(row['Dividends'])
                 for ts, row in frame.iterrows() if row['Dividends'] > 0}
    return closes, dividends


def on_or_before(series, day):
    for back in range(10):
        candidate = day - timedelta(days=back)
        if candidate in series:
            return candidate, series[candidate]
    raise SystemExit(f'no close near {day}')


def main():
    eurusd, _ = history('EURUSD=X')
    data = {symbol: history(symbol) for symbol in NAMES}

    def eur(symbol, day, value):
        return value / on_or_before(eurusd, day)[1] if symbol in USD else value

    rows = []
    for d, account, amount in DEPOSITS:
        rows.append((date.fromisoformat(d), 'DEPOSIT', account, '', '', '', '', '', f'{amount:.2f}'))
    for d, account, amount in WITHDRAWALS:
        rows.append((date.fromisoformat(d), 'WITHDRAWAL', account, '', '', '', '', '', f'{amount:.2f}'))

    trades = [(date.fromisoformat(d), 'BUY', a, s, budget) for d, a, s, budget in BUYS]
    trades += [(date.fromisoformat(d), 'SELL', a, s, share) for d, a, s, share in SELLS]
    held = {}
    for day, kind, account, symbol, size in sorted(trades):
        day, close = on_or_before(data[symbol][0], day)
        price = round(eur(symbol, day, close), 2)
        key = (account, symbol)
        if kind == 'BUY':
            quantity = max(1, math.floor(size / price))
            held[key] = held.get(key, 0) + quantity
        else:
            quantity = max(1, round(held[key] * size))
            held[key] -= quantity
        rows.append((day, kind, account, symbol, NAMES[symbol], str(quantity),
                     f'{price:.2f}', f'{FEE[account]:.2f}', ''))

    # Dividends: the real per-share payout times what the account held that day.
    for (account, symbol) in {(r[2], r[3]) for r in rows if r[1] == 'BUY'}:
        if symbol not in PAYERS or account != 'pea':
            continue
        for day, per_share in sorted(data[symbol][1].items()):
            quantity = sum(int(r[5]) * (1 if r[1] == 'BUY' else -1) for r in rows
                           if r[2] == account and r[3] == symbol and r[0] < day
                           and r[1] in ('BUY', 'SELL'))
            if quantity > 0:
                rows.append((day, 'DIVIDEND', account, symbol, NAMES[symbol], '', '', '',
                             f'{quantity * eur(symbol, day, per_share):.2f}'))

    rows.sort(key=lambda r: (r[0], r[1] != 'DEPOSIT'))
    with OUT.open('w', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['date', 'event_type', 'account', 'symbol', 'name', 'quantity',
                         'unit_price', 'fee', 'amount', 'notes'])
        for row in rows:
            writer.writerow([row[0].isoformat(), *row[1:], ''])
    print(f'{len(rows)} events -> {OUT}')


if __name__ == '__main__':
    main()
