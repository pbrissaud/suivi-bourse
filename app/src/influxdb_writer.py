"""
InfluxDB Writer Module for SuiviBourse
Handles writing and reading metrics to/from InfluxDB 3.x
"""
import os
from datetime import date, datetime, timezone
from typing import Dict, List, Optional, Any

from influxdb_client_3 import InfluxDBClient3, Point, WritePrecision
from logfmt_logger import getLogger

from events.schemas import DEFAULT_ACCOUNT, AccountMetricPoint, PortfolioTotalPoint
# The COALESCE(account,'default') + escaping rule, the NaN guard and the UTC
# literal formatter now live in influx_sql.py, shared with the read layer the
# web UI sits on (issue #659). Imported under their original private names so
# every call site below reads unchanged.
from influx_sql import (
    escape_literal,
    is_valid_number as _is_valid_number,
    symbol_account_where as _symbol_account_where,
    utc_z as _utc_z,
)

LOG_LEVEL = (os.getenv('LOG_LEVEL') or '').strip() or 'INFO'
logger = getLogger("influxdb_writer", level=LOG_LEVEL)


class InfluxDBWriter:
    """
    Handles writing portfolio metrics to InfluxDB 3.x.
    Uses a single measurement 'portfolio_metrics' with tags for share identification
    and fields for all metric values.
    """

    MEASUREMENT = "portfolio_metrics"
    ACCOUNT_MEASUREMENT = "account_metrics"
    PORTFOLIO_MEASUREMENT = "portfolio_totals"

    # Performance fields written only when computable (None is skipped).
    _PERF_FIELDS = ("xirr", "gain_absolu", "twr_index")
    _ACCOUNT_FIELDS = ("cash_balance", "holdings_value", "total_value", "net_contributed")

    def __init__(
        self,
        host: str = None,
        token: str = None,
        database: str = None
    ):
        """
        Initialize the InfluxDB writer.

        Args:
            host: InfluxDB host URL (default: from INFLUXDB_HOST env var)
            token: InfluxDB API token (default: from INFLUXDB_TOKEN env var)
            database: InfluxDB database (default: from INFLUXDB_DATABASE env var)
        """
        # ``.strip() or default`` throughout: a blank env var counts as unset,
        # since compose renders an undefined substitution as an empty string.
        self.host = host or (os.getenv('INFLUXDB_HOST') or '').strip() \
            or 'http://influxdb:8181'
        self.token = token or (os.getenv('INFLUXDB_TOKEN') or '').strip()
        self.database = database or (os.getenv('INFLUXDB_DATABASE') or '').strip() \
            or 'suivi_bourse'

        self._client: Optional[InfluxDBClient3] = None

    def connect(self) -> None:
        """Establish connection to InfluxDB."""
        if self._client is not None:
            return

        self._client = InfluxDBClient3(
            host=self.host,
            token=self.token,
            database=self.database
        )
        logger.info(f"Connected to InfluxDB at {self.host}")

    def close(self) -> None:
        """Close the InfluxDB connection."""
        if self._client is not None:
            self._client.close()
            self._client = None
            logger.info("InfluxDB connection closed")

    def write_metrics(
        self,
        share_name: str,
        share_symbol: str,
        account: str = DEFAULT_ACCOUNT,
        share_price: Optional[float] = None,
        purchased_quantity: Optional[float] = None,
        purchased_price: Optional[float] = None,
        purchased_fee: Optional[float] = None,
        owned_quantity: Optional[float] = None,
        received_dividend: Optional[float] = None,
        share_currency: Optional[str] = None,
        share_exchange: Optional[str] = None,
        quote_type: Optional[str] = None,
        dividend_yield: Optional[float] = None,
        pe_ratio: Optional[float] = None,
        market_cap: Optional[float] = None,
        volume: Optional[int] = None,
        timestamp: Optional[datetime] = None
    ) -> None:
        """
        Write metrics for a single share to InfluxDB.

        Args:
            share_name: Name of the share (tag)
            share_symbol: Yahoo Finance symbol (tag)
            account: Account bucket (tag, default 'default')
            share_price: Current price (field)
            purchased_quantity: Quantity purchased (field)
            purchased_price: Weighted average cost price (field)
            purchased_fee: Total fees (field)
            owned_quantity: Currently owned quantity (field)
            received_dividend: Total dividends received (field)
            share_currency: Currency (tag)
            share_exchange: Exchange (tag)
            quote_type: Type (EQUITY, ETF, etc.) (tag)
            dividend_yield: Dividend yield percentage (field)
            pe_ratio: P/E ratio (field)
            market_cap: Market capitalization (field)
            volume: Trading volume (field)
            timestamp: Timestamp for the data point (default: now)
        """
        if self._client is None:
            self.connect()

        point = Point(self.MEASUREMENT)

        # Tags (always set)
        point.tag("share_name", share_name)
        point.tag("share_symbol", share_symbol)
        # account is always written (default bucket) so every point carries it
        point.tag("account", account or DEFAULT_ACCOUNT)

        # Optional tags
        if share_currency:
            point.tag("share_currency", share_currency)
        if share_exchange:
            point.tag("share_exchange", share_exchange)
        if quote_type:
            point.tag("quote_type", quote_type)

        # Fields (only set if a real number; NaN is skipped, never written)
        if _is_valid_number(share_price):
            point.field("share_price", float(share_price))
            # Also write OHLC fields for candlestick compatibility
            point.field("price_open", float(share_price))
            point.field("price_high", float(share_price))
            point.field("price_low", float(share_price))
        if purchased_quantity is not None:
            point.field("purchased_quantity", float(purchased_quantity))
        if purchased_price is not None:
            point.field("purchased_price", float(purchased_price))
        if purchased_fee is not None:
            point.field("purchased_fee", float(purchased_fee))
        if owned_quantity is not None:
            point.field("owned_quantity", float(owned_quantity))
        if received_dividend is not None:
            point.field("received_dividend", float(received_dividend))
        if dividend_yield is not None:
            point.field("dividend_yield", float(dividend_yield))
        if pe_ratio is not None:
            point.field("pe_ratio", float(pe_ratio))
        if market_cap is not None:
            point.field("market_cap", float(market_cap))
        if volume is not None:
            point.field("volume", int(volume))

        # Set timestamp
        if timestamp:
            point.time(timestamp, WritePrecision.S)
        else:
            point.time(datetime.now(timezone.utc), WritePrecision.S)

        self._client.write(record=point, write_precision='s')
        logger.debug(f"Written metrics for {share_name} ({share_symbol})")

    def write_historical_prices(
        self,
        share_name: str,
        share_symbol: str,
        prices: List[Dict[str, Any]],
        share_currency: Optional[str] = None,
        share_exchange: Optional[str] = None,
        quote_type: Optional[str] = None,
        account: str = DEFAULT_ACCOUNT
    ) -> int:
        """
        Write historical price data to InfluxDB in batch.

        Args:
            share_name: Name of the share
            share_symbol: Yahoo Finance symbol
            prices: List of dicts with:
                - 'timestamp' (datetime): Data point timestamp
                - 'price' (float): Share price
                - 'purchased_quantity' (float, optional): Purchased quantity at this date
                - 'purchased_price' (float, optional): Weighted avg cost price at this date
                - 'purchased_fee' (float, optional): Cumulative fees at this date
                - 'owned_quantity' (float, optional): Owned quantity at this date
                - 'received_dividend' (float, optional): Cumulative dividends at this date
            share_currency: Currency (tag)
            share_exchange: Exchange (tag)
            quote_type: Type (tag)
            account: Account bucket (tag, default 'default')

        Returns:
            Number of points written
        """
        if self._client is None:
            self.connect()

        points = []
        for price_data in prices:
            # share_price is the mandatory field; skip rows without a valid
            # (non-NaN) close price instead of writing a NaN data point.
            price = price_data.get('price')
            if not _is_valid_number(price):
                logger.debug(f"Skipping historical point with invalid price for {share_symbol}")
                continue

            point = Point(self.MEASUREMENT)
            point.tag("share_name", share_name)
            point.tag("share_symbol", share_symbol)
            point.tag("account", account or DEFAULT_ACCOUNT)

            if share_currency:
                point.tag("share_currency", share_currency)
            if share_exchange:
                point.tag("share_exchange", share_exchange)
            if quote_type:
                point.tag("quote_type", quote_type)

            point.field("share_price", float(price))

            # Write OHLC / volume fields if present and numeric (NaN skipped)
            if _is_valid_number(price_data.get('price_open')):
                point.field("price_open", float(price_data['price_open']))
            if _is_valid_number(price_data.get('price_high')):
                point.field("price_high", float(price_data['price_high']))
            if _is_valid_number(price_data.get('price_low')):
                point.field("price_low", float(price_data['price_low']))
            if _is_valid_number(price_data.get('volume')):
                point.field("volume", int(price_data['volume']))

            # Write portfolio fields if available
            if 'purchased_quantity' in price_data and price_data['purchased_quantity'] is not None:
                point.field("purchased_quantity", float(price_data['purchased_quantity']))
            if 'purchased_price' in price_data and price_data['purchased_price'] is not None:
                point.field("purchased_price", float(price_data['purchased_price']))
            if 'purchased_fee' in price_data and price_data['purchased_fee'] is not None:
                point.field("purchased_fee", float(price_data['purchased_fee']))
            if 'owned_quantity' in price_data and price_data['owned_quantity'] is not None:
                point.field("owned_quantity", float(price_data['owned_quantity']))
            if 'received_dividend' in price_data and price_data['received_dividend'] is not None:
                point.field("received_dividend", float(price_data['received_dividend']))

            point.time(price_data['timestamp'], WritePrecision.S)
            points.append(point)

        if points:
            self._client.write(record=points, write_precision='s')
            logger.info(f"Written {len(points)} historical prices for {share_name}")

        return len(points)

    def get_oldest_timestamp(
        self, share_symbol: str, account: Optional[str] = None
    ) -> Optional[datetime]:
        """
        Get the oldest timestamp for a given share symbol in InfluxDB.

        Args:
            share_symbol: Yahoo Finance symbol
            account: When provided, scope the lookup to this account so backfill
                gaps are detected per account. Uses COALESCE(account, 'default')
                so points written before the account tag existed count as
                'default' — never a bare ``WHERE account = ...`` that would drop
                them.

        Returns:
            Oldest timestamp as datetime, or None if no data exists
        """
        if self._client is None:
            self.connect()

        where = _symbol_account_where(share_symbol, account)
        # Use SQL query for InfluxDB 3
        query = f"""
        SELECT time
        FROM "{self.MEASUREMENT}"
        WHERE {where}
        ORDER BY time ASC
        LIMIT 1
        """

        try:
            table = self._client.query(query=query, language="sql")
            if table and len(table) > 0:
                # Convert Arrow table to Python
                df = table.to_pandas()
                if not df.empty:
                    ts = df.iloc[0]['time']
                    if hasattr(ts, 'to_pydatetime'):
                        return ts.to_pydatetime()
                    return ts
        except Exception as e:
            logger.error(f"Error querying oldest timestamp for {share_symbol}: {e}")

        return None

    def get_newest_timestamp(
        self, share_symbol: str, account: Optional[str] = None
    ) -> Optional[datetime]:
        """
        Get the newest timestamp for a given share symbol in InfluxDB.

        Mirror of ``get_oldest_timestamp`` (``ORDER BY time DESC``), used by the
        forward gap-fill pass (issue #627) to find where the stored series ends
        so it can recover a session missed while the app was down.

        Anchors on the newest **price-bearing** point (``share_price IS NOT
        NULL``): ``write_metrics`` can persist a point without a price, and the
        forward pass exists to fill *price* gaps that ``holdings_value`` reads
        (``get_price_series`` filters the same way). Without the filter a newer
        price-less point would make the forward pass believe coverage reaches
        ``now`` and skip an older missing price range.

        Args:
            share_symbol: Yahoo Finance symbol
            account: When provided, scope the lookup to this account like
                ``get_oldest_timestamp``. Uses COALESCE(account, 'default') so
                points written before the account tag existed count as
                'default' — never a bare ``WHERE account = ...`` that would drop
                them. Scoped per account (not symbol-only like
                ``get_price_series``) because a backfill *coverage* anchor is
                per-series: each account's gap is tracked independently.

        Returns:
            Newest timestamp as datetime, or None if no data exists
        """
        if self._client is None:
            self.connect()

        where = _symbol_account_where(share_symbol, account)
        # Use SQL query for InfluxDB 3
        query = f"""
        SELECT time
        FROM "{self.MEASUREMENT}"
        WHERE {where} AND share_price IS NOT NULL
        ORDER BY time DESC
        LIMIT 1
        """

        try:
            table = self._client.query(query=query, language="sql")
            if table and len(table) > 0:
                # Convert Arrow table to Python
                df = table.to_pandas()
                if not df.empty:
                    ts = df.iloc[0]['time']
                    if hasattr(ts, 'to_pydatetime'):
                        return ts.to_pydatetime()
                    return ts
        except Exception as e:
            logger.error(f"Error querying newest timestamp for {share_symbol}: {e}")

        return None

    def get_newest_price(
        self, share_symbol: str, account: Optional[str] = None
    ) -> Optional[float]:
        """Return the newest stored ``share_price`` for a series, or ``None``.

        Used by the price-freshness liveness sonde (issue #628): the sonde
        compares the newest stored price *value* against the live quote across
        consecutive ``REGULAR`` cycles to catch a writer that fetches fine but
        persists stale values. Anchors on the newest **price-bearing** point
        (``share_price IS NOT NULL``) and scopes by ``share_symbol`` + ``account``
        exactly like ``get_newest_timestamp``.

        Returns ``None`` when the series has no price-bearing point (or the query
        fails — the sonde is diagnostic, a read error must never surface).
        """
        if self._client is None:
            self.connect()

        where = _symbol_account_where(share_symbol, account)
        # Use SQL query for InfluxDB 3
        query = f"""
        SELECT share_price
        FROM "{self.MEASUREMENT}"
        WHERE {where} AND share_price IS NOT NULL
        ORDER BY time DESC
        LIMIT 1
        """

        try:
            table = self._client.query(query=query, language="sql")
            if table and len(table) > 0:
                df = table.to_pandas()
                if not df.empty:
                    return float(df.iloc[0]['share_price'])
        except Exception as e:
            logger.error(f"Error querying newest price for {share_symbol}: {e}")

        return None

    def has_data_for_date(self, share_symbol: str, date: datetime) -> bool:
        """
        Check if data exists for a specific symbol on a given date.

        Args:
            share_symbol: Yahoo Finance symbol
            date: Date to check

        Returns:
            True if data exists, False otherwise
        """
        if self._client is None:
            self.connect()

        start = date.replace(hour=0, minute=0, second=0, microsecond=0)
        stop = date.replace(hour=23, minute=59, second=59, microsecond=999999)

        safe_symbol = escape_literal(share_symbol)
        # Use SQL query for InfluxDB 3
        query = f"""
        SELECT COUNT(*) as count
        FROM "{self.MEASUREMENT}"
        WHERE share_symbol = '{safe_symbol}'
          AND time >= '{_utc_z(start)}'
          AND time <= '{_utc_z(stop)}'
        """

        try:
            table = self._client.query(query=query, language="sql")
            if table and len(table) > 0:
                df = table.to_pandas()
                if not df.empty:
                    return df.iloc[0]['count'] > 0
        except Exception as e:
            logger.error(f"Error checking data for {share_symbol} on {date}: {e}")

        return False

    def get_price_series(self, share_symbol: str) -> Dict[date, float]:
        """Return the daily close price of a symbol from ``portfolio_metrics``.

        🔒 Queries by ``share_symbol`` **only**, never by ``account``: a market
        price belongs to no account, and points written before the account tag
        existed have ``account = NULL`` — filtering on account would silently
        truncate the price history. This is the shared price source consumed by
        the account/performance series.

        Returns a ``{date: close_price}`` mapping (one entry per day that has a
        price), empty if there is no data.
        """
        if self._client is None:
            self.connect()

        safe_symbol = escape_literal(share_symbol)
        # One row per day: the last (latest-time) price of each calendar day.
        query = f"""
        SELECT day, price FROM (
            SELECT date_trunc('day', time) AS day, share_price AS price,
                   ROW_NUMBER() OVER (
                       PARTITION BY date_trunc('day', time) ORDER BY time DESC) AS rn
            FROM "{self.MEASUREMENT}"
            WHERE share_symbol = '{safe_symbol}' AND share_price IS NOT NULL
        ) WHERE rn = 1
        ORDER BY day
        """

        series: Dict[date, float] = {}
        try:
            table = self._client.query(query=query, language="sql")
            if table and len(table) > 0:
                df = table.to_pandas()
                for _, row in df.iterrows():
                    day = row['day']
                    day = day.date() if hasattr(day, 'date') else day
                    series[day] = float(row['price'])
        except Exception as e:
            logger.error(f"Error querying price series for {share_symbol}: {e}")

        return series

    def write_account_metrics(self, points: List[AccountMetricPoint]) -> int:
        """Write the daily ``account_metrics`` series (batch, idempotent).

        Each :class:`AccountMetricPoint` carries the tags ``account`` /
        ``account_type`` / ``account_currency`` and the fields ``cash_balance`` /
        ``holdings_value`` / ``total_value`` / ``net_contributed`` at a midnight
        ``timestamp``. Re-writing the same (tags, time) series overwrites rather
        than duplicates, so writing a recomputed slice each cycle is idempotent.
        The caller writes only the stale tail (issue #597), not the whole series.
        """
        if self._client is None:
            self.connect()

        records = []
        for p in points:
            point = Point(self.ACCOUNT_MEASUREMENT)
            point.tag("account", p.account or DEFAULT_ACCOUNT)
            if p.account_type:
                point.tag("account_type", p.account_type)
            if p.account_currency:
                point.tag("account_currency", p.account_currency)

            self._set_value_fields(point, p)
            point.time(p.timestamp, WritePrecision.S)
            records.append(point)

        if records:
            self._client.write(record=records, write_precision='s')
            logger.info(f"Written {len(records)} account_metrics points")

        return len(records)

    def _set_value_fields(self, point: Point, p: Any) -> None:
        """Set the shared value + performance fields on a point (skipping NaN/None)."""
        for field_name in self._ACCOUNT_FIELDS + self._PERF_FIELDS:
            value = getattr(p, field_name)
            if _is_valid_number(value):
                point.field(field_name, float(value))

    def write_portfolio_totals(self, points: List[PortfolioTotalPoint]) -> int:
        """Write the global ``portfolio_totals`` series (batch, idempotent).

        A single **untagged** series (tagging it would double every ``SUM()`` over
        the per-account series). Same 7 perf fields, same midnight-stamped,
        stale-tail-only idempotent write as ``account_metrics``.
        """
        if self._client is None:
            self.connect()

        records = []
        for p in points:
            point = Point(self.PORTFOLIO_MEASUREMENT)
            self._set_value_fields(point, p)
            point.time(p.timestamp, WritePrecision.S)
            records.append(point)

        if records:
            self._client.write(record=records, write_precision='s')
            logger.info(f"Written {len(records)} portfolio_totals points")

        return len(records)

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
