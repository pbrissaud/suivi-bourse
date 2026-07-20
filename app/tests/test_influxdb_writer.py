"""
Unit tests for ``influxdb_writer.InfluxDBWriter``.

Everything external is mocked: ``influxdb_writer.InfluxDBClient3`` is replaced by
a MagicMock class so no real InfluxDB connection is ever opened. Assertions read
the internal state of the real ``influxdb_client_3.Point`` objects the writer
builds (``_name`` / ``_tags`` / ``_fields`` / ``_time``) and the exact SQL string
the writer hands to ``client.query``.
"""

from datetime import datetime, timezone

import pandas as pd
import pytest

import influxdb_writer
from influxdb_writer import InfluxDBWriter


# --------------------------------------------------------------------------- #
# Local helpers / fixtures                                                     #
# --------------------------------------------------------------------------- #
class FakeTable:
    """Stand-in for the Arrow table returned by ``client.query``.

    Supports ``len()`` and ``.to_pandas()`` exactly like the code path in
    ``get_oldest_timestamp`` / ``has_data_for_date`` expects. ``length`` lets a
    test force an explicit length independent of the dataframe.
    """

    def __init__(self, df, length=None):
        self._df = df
        self._len = length if length is not None else len(df)

    def __len__(self):
        return self._len

    def to_pandas(self):
        return self._df


@pytest.fixture
def mock_client_cls(mocker):
    """Patch ``influxdb_writer.InfluxDBClient3`` with a MagicMock class.

    - Constructor kwargs are captured via ``mock_client_cls.call_args``.
    - The single client instance is ``mock_client_cls.return_value`` and its
      ``.write`` / ``.query`` / ``.close`` are auto-created child mocks.
    """
    return mocker.patch.object(influxdb_writer, "InfluxDBClient3")


@pytest.fixture
def writer(mock_client_cls):
    """A freshly constructed InfluxDBWriter with explicit (non-env) config."""
    return InfluxDBWriter(
        host="http://test-host:8181",
        token="secret-token",
        database="test_db",
    )


def _last_written_record(client):
    """The ``record=`` argument of the most recent ``client.write`` call."""
    return client.write.call_args.kwargs["record"]


def _last_query(client):
    """The ``query=`` argument of the most recent ``client.query`` call."""
    return client.query.call_args.kwargs["query"]


# --------------------------------------------------------------------------- #
# connect / close / context manager                                           #
# --------------------------------------------------------------------------- #
def test_connect_builds_client_with_config(writer, mock_client_cls):
    writer.connect()

    mock_client_cls.assert_called_once_with(
        host="http://test-host:8181",
        token="secret-token",
        database="test_db",
    )
    assert writer._client is mock_client_cls.return_value


def test_connect_is_idempotent(writer, mock_client_cls):
    writer.connect()
    writer.connect()
    writer.connect()

    # Second/third calls must NOT recreate the client.
    assert mock_client_cls.call_count == 1


def test_close_nulls_the_client(writer, mock_client_cls):
    writer.connect()
    client = mock_client_cls.return_value

    writer.close()

    client.close.assert_called_once()
    assert writer._client is None


def test_close_without_connect_is_safe(writer, mock_client_cls):
    # Never connected: close() must be a no-op and not blow up.
    writer.close()
    assert writer._client is None
    mock_client_cls.return_value.close.assert_not_called()


def test_context_manager_connects_then_closes(writer, mock_client_cls):
    client = mock_client_cls.return_value

    with writer as w:
        assert w is writer
        assert writer._client is client
        client.close.assert_not_called()

    client.close.assert_called_once()
    assert writer._client is None


def test_context_manager_exit_does_not_suppress(writer, mock_client_cls):
    # __exit__ returns False -> exceptions propagate out of the with-block.
    with pytest.raises(ValueError):
        with writer:
            raise ValueError("boom")
    # Cleanup still ran.
    assert writer._client is None


# --------------------------------------------------------------------------- #
# Environment-variable defaults                                               #
# --------------------------------------------------------------------------- #
def test_env_var_defaults_used_when_not_passed(mock_client_cls, monkeypatch):
    monkeypatch.setenv("INFLUXDB_HOST", "http://env-host:9999")
    monkeypatch.setenv("INFLUXDB_TOKEN", "env-token")
    monkeypatch.setenv("INFLUXDB_DATABASE", "env_db")

    w = InfluxDBWriter()  # no explicit args -> read from env
    assert w.host == "http://env-host:9999"
    assert w.token == "env-token"
    assert w.database == "env_db"

    w.connect()
    mock_client_cls.assert_called_once_with(
        host="http://env-host:9999",
        token="env-token",
        database="env_db",
    )


def test_hardcoded_defaults_when_env_missing(mock_client_cls, monkeypatch):
    monkeypatch.delenv("INFLUXDB_HOST", raising=False)
    monkeypatch.delenv("INFLUXDB_TOKEN", raising=False)
    monkeypatch.delenv("INFLUXDB_DATABASE", raising=False)

    w = InfluxDBWriter()
    assert w.host == "http://influxdb:8181"
    assert w.database == "suivi_bourse"
    assert w.token == ""  # token falls back to empty string


# --------------------------------------------------------------------------- #
# write_metrics                                                                #
# --------------------------------------------------------------------------- #
def test_write_metrics_measurement_and_mandatory_tags(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(share_name="Apple", share_symbol="AAPL", share_price=150.0)

    point = _last_written_record(client)
    assert point._name == InfluxDBWriter.MEASUREMENT == "portfolio_metrics"
    assert point._tags["share_name"] == "Apple"
    assert point._tags["share_symbol"] == "AAPL"
    # write() called with second-precision.
    assert client.write.call_args.kwargs["write_precision"] == "s"


def test_write_metrics_mandatory_tags_always_present_even_without_optionals(
    writer, mock_client_cls
):
    client = mock_client_cls.return_value

    writer.write_metrics(share_name="Micro", share_symbol="MSFT")

    point = _last_written_record(client)
    # The mandatory tags (name, symbol, account) are always present, no optionals.
    assert set(point._tags.keys()) == {"share_name", "share_symbol", "account"}
    # account defaults to 'default' so every point carries it.
    assert point._tags["account"] == "default"


def test_write_metrics_account_tag_when_provided(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(share_name="Apple", share_symbol="AAPL", account="PEA")

    point = _last_written_record(client)
    assert point._tags["account"] == "PEA"


def test_write_historical_prices_carries_account_tag(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_historical_prices(
        share_name="Apple", share_symbol="AAPL",
        prices=[{"timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc), "price": 100.0}],
        account="CTO",
    )

    records = client.write.call_args.kwargs["record"]
    point = records[0] if isinstance(records, list) else records
    assert point._tags["account"] == "CTO"


def test_write_metrics_optional_tags_only_when_provided(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(
        share_name="Apple",
        share_symbol="AAPL",
        share_currency="USD",
        share_exchange="NMS",
        quote_type="EQUITY",
    )

    point = _last_written_record(client)
    assert point._tags["share_currency"] == "USD"
    assert point._tags["share_exchange"] == "NMS"
    assert point._tags["quote_type"] == "EQUITY"


def test_write_metrics_share_price_mirrors_ohlc(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(share_name="Apple", share_symbol="AAPL", share_price=123.45)

    fields = _last_written_record(client)._fields
    assert fields["share_price"] == 123.45
    # share_price is mirrored into open/high/low for candlestick compatibility.
    assert fields["price_open"] == 123.45
    assert fields["price_high"] == 123.45
    assert fields["price_low"] == 123.45


def test_write_metrics_no_share_price_omits_ohlc(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(
        share_name="Apple", share_symbol="AAPL", purchased_quantity=10
    )

    fields = _last_written_record(client)._fields
    for key in ("share_price", "price_open", "price_high", "price_low"):
        assert key not in fields


def test_write_metrics_nan_share_price_omits_price_and_ohlc(writer, mock_client_cls):
    client = mock_client_cls.return_value

    # A NaN close (holiday / partial bar) must never be written as a NaN field.
    writer.write_metrics(
        share_name="Apple", share_symbol="AAPL",
        share_price=float("nan"), purchased_quantity=10,
    )

    fields = _last_written_record(client)._fields
    for key in ("share_price", "price_open", "price_high", "price_low"):
        assert key not in fields
    assert fields["purchased_quantity"] == 10.0


def test_write_metrics_none_fields_are_omitted(writer, mock_client_cls):
    client = mock_client_cls.return_value

    # Provide only some fields; everything left as None must be absent.
    writer.write_metrics(
        share_name="Apple",
        share_symbol="AAPL",
        purchased_quantity=10,
        owned_quantity=12,
    )

    fields = _last_written_record(client)._fields
    assert fields == {"purchased_quantity": 10.0, "owned_quantity": 12.0}
    for key in (
        "share_price",
        "purchased_price",
        "purchased_fee",
        "received_dividend",
        "dividend_yield",
        "pe_ratio",
        "market_cap",
        "volume",
    ):
        assert key not in fields


def test_write_metrics_all_fields_written_and_typed(writer, mock_client_cls):
    client = mock_client_cls.return_value

    writer.write_metrics(
        share_name="Apple",
        share_symbol="AAPL",
        share_price=100.0,
        purchased_quantity=10,
        purchased_price=95.0,
        purchased_fee=2.5,
        owned_quantity=11,
        received_dividend=3.0,
        dividend_yield=0.5,
        pe_ratio=28.5,
        market_cap=3_000_000_000_000,
        volume=5,
    )

    fields = _last_written_record(client)._fields
    # Numeric fields coerced to float (except volume -> int).
    assert fields["purchased_quantity"] == 10.0
    assert isinstance(fields["purchased_quantity"], float)
    assert fields["market_cap"] == 3_000_000_000_000.0
    assert isinstance(fields["market_cap"], float)


def test_write_metrics_volume_cast_to_int(writer, mock_client_cls):
    client = mock_client_cls.return_value

    # Pass a float volume; the writer must store a genuine int.
    writer.write_metrics(
        share_name="Apple", share_symbol="AAPL", volume=5.9
    )

    volume = _last_written_record(client)._fields["volume"]
    assert volume == 5
    assert isinstance(volume, int)


def test_write_metrics_default_timestamp_is_now(writer, mock_client_cls):
    client = mock_client_cls.return_value
    before = datetime.now(timezone.utc)

    writer.write_metrics(share_name="Apple", share_symbol="AAPL", share_price=100.0)

    after = datetime.now(timezone.utc)
    ts = _last_written_record(client)._time
    assert ts is not None
    assert ts.tzinfo is not None
    # Default timestamp is "now" (UTC), bracketed by the surrounding wall clock.
    assert before <= ts <= after


def test_write_metrics_explicit_timestamp_preserved(writer, mock_client_cls):
    client = mock_client_cls.return_value
    fixed = datetime(2024, 1, 2, 3, 4, 5, tzinfo=timezone.utc)

    writer.write_metrics(
        share_name="Apple", share_symbol="AAPL", share_price=100.0, timestamp=fixed
    )

    assert _last_written_record(client)._time == fixed


def test_write_metrics_auto_connects(writer, mock_client_cls):
    # No explicit connect() -> write_metrics must open the client itself.
    assert writer._client is None
    writer.write_metrics(share_name="Apple", share_symbol="AAPL", share_price=1.0)
    assert writer._client is mock_client_cls.return_value
    mock_client_cls.assert_called_once()


# --------------------------------------------------------------------------- #
# write_historical_prices                                                      #
# --------------------------------------------------------------------------- #
def test_write_historical_prices_returns_count_and_batches(writer, mock_client_cls):
    client = mock_client_cls.return_value
    prices = [
        {"timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc), "price": 10.0},
        {"timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc), "price": 11.0},
        {"timestamp": datetime(2024, 1, 3, tzinfo=timezone.utc), "price": 12.0},
    ]

    written = writer.write_historical_prices("Apple", "AAPL", prices)

    assert written == 3
    # Everything is batched into a SINGLE write call with a list of points.
    client.write.assert_called_once()
    record = _last_written_record(client)
    assert isinstance(record, list)
    assert len(record) == 3
    assert all(p._name == "portfolio_metrics" for p in record)
    assert client.write.call_args.kwargs["write_precision"] == "s"


def test_write_historical_prices_mandatory_and_optional_tags(writer, mock_client_cls):
    client = mock_client_cls.return_value
    prices = [{"timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc), "price": 10.0}]

    writer.write_historical_prices(
        "Apple",
        "AAPL",
        prices,
        share_currency="USD",
        share_exchange="NMS",
        quote_type="EQUITY",
    )

    tags = _last_written_record(client)[0]._tags
    assert tags["share_name"] == "Apple"
    assert tags["share_symbol"] == "AAPL"
    assert tags["share_currency"] == "USD"
    assert tags["share_exchange"] == "NMS"
    assert tags["quote_type"] == "EQUITY"


def test_write_historical_prices_optional_fields_only_when_present(
    writer, mock_client_cls
):
    client = mock_client_cls.return_value
    prices = [
        # Rich row: all optional OHLC / volume / portfolio fields present.
        {
            "timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc),
            "price": 10.0,
            "price_open": 9.5,
            "price_high": 10.5,
            "price_low": 9.0,
            "volume": 1234.0,
            "purchased_quantity": 5,
            "purchased_price": 8.0,
            "purchased_fee": 1.0,
            "owned_quantity": 5,
            "received_dividend": 0.5,
        },
        # Sparse row: only price -> optional fields must be absent.
        {"timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc), "price": 11.0},
    ]

    writer.write_historical_prices("Apple", "AAPL", prices)

    rich, sparse = _last_written_record(client)

    # Rich point carries everything, volume cast to int.
    assert rich._fields["share_price"] == 10.0
    assert rich._fields["price_open"] == 9.5
    assert rich._fields["price_high"] == 10.5
    assert rich._fields["price_low"] == 9.0
    assert rich._fields["volume"] == 1234
    assert isinstance(rich._fields["volume"], int)
    assert rich._fields["purchased_quantity"] == 5.0
    assert rich._fields["purchased_price"] == 8.0
    assert rich._fields["purchased_fee"] == 1.0
    assert rich._fields["owned_quantity"] == 5.0
    assert rich._fields["received_dividend"] == 0.5

    # Sparse point has ONLY share_price.
    assert sparse._fields == {"share_price": 11.0}


def test_write_historical_prices_none_valued_optionals_omitted(writer, mock_client_cls):
    client = mock_client_cls.return_value
    prices = [
        {
            "timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc),
            "price": 10.0,
            "price_open": None,
            "volume": None,
            "purchased_quantity": None,
        }
    ]

    writer.write_historical_prices("Apple", "AAPL", prices)

    fields = _last_written_record(client)[0]._fields
    assert fields == {"share_price": 10.0}


def test_write_historical_prices_skips_nan_price_rows(writer, mock_client_cls):
    client = mock_client_cls.return_value
    prices = [
        {"timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc), "price": 10.0},
        # NaN close -> row skipped entirely, not written as a NaN point.
        {"timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc), "price": float("nan")},
        {"timestamp": datetime(2024, 1, 3, tzinfo=timezone.utc), "price": 12.0},
    ]

    written = writer.write_historical_prices("Apple", "AAPL", prices)

    assert written == 2
    records = _last_written_record(client)
    assert [r._fields["share_price"] for r in records] == [10.0, 12.0]


def test_write_historical_prices_nan_ohlc_and_volume_omitted(writer, mock_client_cls):
    client = mock_client_cls.return_value
    prices = [
        {
            "timestamp": datetime(2024, 1, 1, tzinfo=timezone.utc),
            "price": 10.0,
            "price_open": float("nan"),
            "price_high": 10.5,
            "price_low": float("nan"),
            "volume": float("nan"),
        }
    ]

    writer.write_historical_prices("Apple", "AAPL", prices)

    fields = _last_written_record(client)[0]._fields
    assert fields == {"share_price": 10.0, "price_high": 10.5}


def test_write_historical_prices_timestamp_from_data(writer, mock_client_cls):
    client = mock_client_cls.return_value
    ts = datetime(2023, 5, 6, 7, 8, 9, tzinfo=timezone.utc)
    prices = [{"timestamp": ts, "price": 10.0}]

    writer.write_historical_prices("Apple", "AAPL", prices)

    assert _last_written_record(client)[0]._time == ts


def test_write_historical_prices_empty_list_returns_zero_no_write(
    writer, mock_client_cls
):
    client = mock_client_cls.return_value

    written = writer.write_historical_prices("Apple", "AAPL", [])

    assert written == 0
    client.write.assert_not_called()


# --------------------------------------------------------------------------- #
# get_oldest_timestamp                                                         #
# --------------------------------------------------------------------------- #
def test_get_oldest_timestamp_returns_datetime(writer, mock_client_cls):
    client = mock_client_cls.return_value
    df = pd.DataFrame({"time": [pd.Timestamp("2020-01-02T03:04:05Z")]})
    client.query.return_value = FakeTable(df)

    result = writer.get_oldest_timestamp("AAPL")

    assert isinstance(result, datetime)
    assert result == datetime(2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def test_get_oldest_timestamp_plain_datetime_passthrough(writer, mock_client_cls):
    client = mock_client_cls.return_value
    plain = datetime(2019, 9, 9, tzinfo=timezone.utc)
    # object-dtype column so pandas keeps the raw python datetime (no to_pydatetime)
    df = pd.DataFrame({"time": pd.Series([plain], dtype="object")})
    client.query.return_value = FakeTable(df)

    result = writer.get_oldest_timestamp("AAPL")
    assert result == plain


def test_get_oldest_timestamp_empty_returns_none(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"time": []}), length=0)

    assert writer.get_oldest_timestamp("AAPL") is None


def test_get_oldest_timestamp_exception_returns_none(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.side_effect = RuntimeError("db down")

    assert writer.get_oldest_timestamp("AAPL") is None


def test_get_oldest_timestamp_query_targets_symbol_and_measurement(
    writer, mock_client_cls
):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"time": []}), length=0)

    writer.get_oldest_timestamp("AAPL")

    q = _last_query(client)
    assert 'FROM "portfolio_metrics"' in q
    assert "share_symbol = 'AAPL'" in q
    assert client.query.call_args.kwargs["language"] == "sql"


# --------------------------------------------------------------------------- #
# has_data_for_date                                                            #
# --------------------------------------------------------------------------- #
def test_has_data_for_date_true_when_count_positive(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [3]}))

    # count > 0 -> truthy (the writer returns a numpy bool here, not python True).
    assert writer.has_data_for_date("AAPL", datetime(2024, 1, 1))


def test_has_data_for_date_false_when_count_zero(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [0]}))

    # count == 0 -> falsy.
    assert not writer.has_data_for_date("AAPL", datetime(2024, 1, 1))


def test_has_data_for_date_false_on_empty(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": []}), length=0)

    assert writer.has_data_for_date("AAPL", datetime(2024, 1, 1)) is False


def test_has_data_for_date_false_on_exception(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.side_effect = RuntimeError("db down")

    assert writer.has_data_for_date("AAPL", datetime(2024, 1, 1)) is False


def test_has_data_for_date_query_uses_day_bounds(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [1]}))

    writer.has_data_for_date("AAPL", datetime(2024, 3, 15, 14, 30))

    q = _last_query(client)
    assert "COUNT(*)" in q
    assert 'FROM "portfolio_metrics"' in q
    # Day is bracketed from 00:00:00 to 23:59:59.
    assert "2024-03-15T00:00:00" in q
    assert "2024-03-15T23:59:59" in q


def test_has_data_for_date_timezone_aware_yields_valid_z_literal(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [1]}))

    # A tz-aware input must not produce an invalid '...+00:00Z' timestamp.
    writer.has_data_for_date("AAPL", datetime(2024, 3, 15, 14, 30, tzinfo=timezone.utc))

    q = _last_query(client)
    assert "+00:00Z" not in q
    assert "2024-03-15T00:00:00Z" in q
    assert "2024-03-15T23:59:59.999999Z" in q


# --------------------------------------------------------------------------- #
# SQL-injection safety: single quotes must be doubled                          #
# --------------------------------------------------------------------------- #
def test_get_oldest_timestamp_escapes_single_quote(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"time": []}), length=0)

    writer.get_oldest_timestamp("O'Reilly")

    q = _last_query(client)
    # The quote is doubled -> stays inside the string literal.
    assert "share_symbol = 'O''Reilly'" in q
    # And the naive unescaped form never appears.
    assert "'O'Reilly'" not in q


def test_get_oldest_timestamp_neutralizes_injection_payload(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"time": []}), length=0)

    payload = "x'; DROP TABLE portfolio_metrics; --"
    writer.get_oldest_timestamp(payload)

    q = _last_query(client)
    # Every single quote in the payload is doubled.
    assert "x''; DROP TABLE portfolio_metrics; --" in q


def test_has_data_for_date_escapes_single_quote(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [0]}))

    writer.has_data_for_date("O'Reilly", datetime(2024, 1, 1))

    q = _last_query(client)
    assert "share_symbol = 'O''Reilly'" in q
    assert "'O'Reilly'" not in q


def test_has_data_for_date_neutralizes_injection_payload(writer, mock_client_cls):
    client = mock_client_cls.return_value
    client.query.return_value = FakeTable(pd.DataFrame({"count": [0]}))

    payload = "y'; DELETE FROM portfolio_metrics; --"
    writer.has_data_for_date(payload, datetime(2024, 1, 1))

    q = _last_query(client)
    assert "y''; DELETE FROM portfolio_metrics; --" in q
