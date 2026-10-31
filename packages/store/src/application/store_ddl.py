"""The store's schema as DDL: what a new file is, and the tables that make it."""

_DDL_DECLARED = """
CREATE TABLE IF NOT EXISTS account (
    id         VARCHAR PRIMARY KEY,
    label      VARCHAR NOT NULL);

CREATE TABLE IF NOT EXISTS symbol (symbol VARCHAR PRIMARY KEY);

-- The owner's own taxation models (#752). Reusable across accounts,
-- so they have an identity of their own rather than living on the account.
-- `parameters` is **one JSON value in one column** and not a column per field,
-- which is what makes a kind added in version n+1 an addition rather than a
-- schema step to write.
CREATE TABLE IF NOT EXISTS taxation_model (
    id          VARCHAR PRIMARY KEY,
    name        VARCHAR NOT NULL,
    kind        VARCHAR NOT NULL,                    -- one of taxation.KINDS
    parameters  VARCHAR NOT NULL);                   -- the kind's own, as JSON

-- What its owner declares **about an account** and no computation can produce
-- (#752). Keyed by the account, one writer, and an **absent row is an
-- absence**: no model declared is not a model of nothing.
CREATE TABLE IF NOT EXISTS account_fact (
    account         VARCHAR PRIMARY KEY REFERENCES account(id),
    taxation_model  VARCHAR REFERENCES taxation_model(id),
    opened_on       DATE);                           -- declared by #918

CREATE TABLE IF NOT EXISTS event (
    id            BIGINT  PRIMARY KEY,
    date          DATE    NOT NULL,
    event_type    VARCHAR NOT NULL,
    account       VARCHAR NOT NULL REFERENCES account(id),
    symbol        VARCHAR REFERENCES symbol(symbol),  -- NULL on DEPOSIT/WITHDRAWAL
    name          VARCHAR,
    quantity      DOUBLE,
    unit_price    DOUBLE,      -- an amount in the reporting currency; optional on GRANT
    fee           DOUBLE,
    amount        DOUBLE,
    notes         VARCHAR,
    amounts_currency VARCHAR);  -- NULL: nobody said (#1261); else the unit the amounts were written in
"""

_DDL_DERIVED_FROM_EVENTS = """
CREATE TABLE IF NOT EXISTS position (
    account            VARCHAR NOT NULL REFERENCES account(id),
    symbol             VARCHAR NOT NULL REFERENCES symbol(symbol),
    name               VARCHAR,
    quantity           DOUBLE  NOT NULL,
    cost_basis         DOUBLE  NOT NULL,            -- an *amount*; the unit WAC is derived
    realized_gain      DOUBLE  NOT NULL,
    received_dividend  DOUBLE  NOT NULL,
    PRIMARY KEY (account, symbol));

CREATE TABLE IF NOT EXISTS account_state (
    account          VARCHAR PRIMARY KEY REFERENCES account(id),
    cash_balance     DOUBLE NOT NULL,
    net_contributed  DOUBLE NOT NULL);
"""

_DDL_DERIVED_FROM_MARKET = """
CREATE TABLE IF NOT EXISTS symbol_quote (
    symbol                VARCHAR PRIMARY KEY REFERENCES symbol(symbol),
    currency              VARCHAR,
    exchange              VARCHAR,
    quote_type            VARCHAR,
    dividend_yield        DOUBLE,
    pe_ratio              DOUBLE,
    market_cap            DOUBLE,
    sector                VARCHAR,                   -- what it does (#964)
    industry              VARCHAR,
    country               VARCHAR,                   -- *not* Yahoo's `region`
    long_name             VARCHAR,                   -- what Yahoo calls it (#1386)
    fetched_at            TIMESTAMPTZ,
    last_price_native     DOUBLE,                   -- the `latest` row
    last_price_converted  DOUBLE,
    last_fx_rate          DOUBLE,
    last_price_ts         TIMESTAMPTZ,
    oldest_window_tried   DATE,                     -- the persisted backward-pass anchor
    newest_window_tried   DATE,                     -- and the forward pass's own (#854)
    splits_read_at        TIMESTAMPTZ);             -- when the split history was last read (#760)
"""

_DDL_PRICE_POINT = """
CREATE TABLE IF NOT EXISTS price_point (
    symbol           VARCHAR     NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,
    price_native     DOUBLE,
    price_converted  DOUBLE,                        -- NULL = transient, repaired later
    fx_rate          DOUBLE);

-- The ratios ``price_point`` no longer carries (#760). #988 put every close
-- back in the share the market printed it in, which is what the ledger's
-- quantities are in -- and that correction consumes the split factors and
-- throws them away. Anything counting **units** across a split still needs
-- them: the counterfactual replay buys shares of a reference and holds them
-- for years, so a 1-for-4 it cannot see divides its holding by four in
-- silence. Written where they are already read, as a whole history per
-- symbol: a partial one is worse than none.
CREATE TABLE IF NOT EXISTS symbol_split (
    symbol  VARCHAR NOT NULL,
    day     DATE    NOT NULL,
    ratio   DOUBLE  NOT NULL,
    PRIMARY KEY (symbol, day));
"""

_DDL_DERIVED_FROM_COMPUTATION = """
CREATE TABLE IF NOT EXISTS account_metrics (
    account          VARCHAR NOT NULL REFERENCES account(id),
    day              DATE    NOT NULL,
    cash_balance     DOUBLE, holdings_value DOUBLE, total_value DOUBLE,
    net_contributed  DOUBLE, xirr DOUBLE, gain_absolu DOUBLE, twr_index DOUBLE,
    PRIMARY KEY (account, day));

CREATE TABLE IF NOT EXISTS portfolio_totals (
    day              DATE PRIMARY KEY,
    cash_balance     DOUBLE, holdings_value DOUBLE, total_value DOUBLE,
    net_contributed  DOUBLE, xirr DOUBLE, gain_absolu DOUBLE, twr_index DOUBLE);
"""

_DDL_SETTINGS_AND_FACTS = """
CREATE TABLE IF NOT EXISTS setting (key VARCHAR PRIMARY KEY, value VARCHAR);

CREATE TABLE IF NOT EXISTS installation_fact (
    key              VARCHAR PRIMARY KEY,
    first_seen_at    TIMESTAMPTZ NOT NULL,
    acknowledged_at  TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS advisory_ack (
    key              VARCHAR PRIMARY KEY,
    acknowledged_at  TIMESTAMPTZ NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL);

-- **What generation this store is** (#926). One row per applied step,
-- and the *absence* of a row is the first generation: every store in the wild
-- predates this table, so no mark is the mark. Created by the DDL like any
-- other table, which is what lets :func:`apply_steps` ask the question a line
-- later on a file that had never heard of it.
CREATE TABLE IF NOT EXISTS schema_step (
    step        VARCHAR PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL);

-- **The agent's provider, and its key in clear** (#1114). One row. Because
-- of ``api_key`` this file now holds a secret: no route may ever serve the
-- store file or a dump of a whole table, and the key leaves the server as its
-- last four characters only (``agent.describe``).
CREATE TABLE IF NOT EXISTS agent_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    provider    VARCHAR,
    model       VARCHAR,
    model_name  VARCHAR,
    base_url    VARCHAR,
    api_key     VARCHAR,
    key_set_at  TIMESTAMPTZ,
    thinking    VARCHAR DEFAULT 'low',
    updated_at  TIMESTAMPTZ NOT NULL);

-- **The PIN and what it opens** (#1203). One row, absent while the PIN is off,
-- so a store from before it boots unlocked. Written and read by ``auth_gate``
-- alone: no settings route, MCP tool or export reads it. ``revoked`` is a JSON
-- object of logged-out session ids to the instant they left.
CREATE TABLE IF NOT EXISTS auth_secret (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    pin_hash          VARCHAR NOT NULL,
    session_secret    VARCHAR NOT NULL,
    token_hash        VARCHAR,
    token_created_at  TIMESTAMPTZ,
    revoked           VARCHAR NOT NULL DEFAULT '{}',
    updated_at        TIMESTAMPTZ NOT NULL);

-- What the owner declares **about themself** (#1116), confirmed in the UI and
-- never written by the agent. An absent row is an absence. ``value`` is JSON,
-- validated by ``application.profile``.
CREATE TABLE IF NOT EXISTS profile_fact (
    key           VARCHAR PRIMARY KEY,   -- 'income' | 'marginal_rate' | 'risk_tolerance' | 'project:<id>'
    value         VARCHAR NOT NULL,
    confirmed_at  TIMESTAMPTZ NOT NULL);

-- What the agent proposes and only the UI decides (#1116, #1119). ``expired``
-- and ``stale`` (events whose ledger moved) are read, never stored: a
-- ``ready`` row older than ``proposals.EXPIRY``.
CREATE TABLE IF NOT EXISTS proposal (
    id          VARCHAR PRIMARY KEY,     -- uuid4 hex
    kind        VARCHAR NOT NULL,        -- 'profile_fact' | 'events'
    payload     VARCHAR NOT NULL,        -- JSON: {"key", "value"} | {"title", "events", "stamp"}
    status      VARCHAR NOT NULL,        -- 'ready' | 'merged' | 'ignored'
    created_at  TIMESTAMPTZ NOT NULL,
    decided_at  TIMESTAMPTZ);
"""

DDL = ''.join((
    _DDL_DECLARED,
    _DDL_DERIVED_FROM_EVENTS,
    _DDL_DERIVED_FROM_MARKET,
    _DDL_PRICE_POINT,
    _DDL_DERIVED_FROM_COMPUTATION,
    _DDL_SETTINGS_AND_FACTS,
))

TABLES = (
    'account', 'symbol', 'event', 'taxation_model', 'account_fact',
    'position', 'account_state',
    'symbol_quote', 'price_point', 'symbol_split',
    'account_metrics', 'portfolio_totals',
    'setting', 'installation_fact', 'advisory_ack', 'schema_step',
    'agent_config', 'auth_secret', 'profile_fact', 'proposal',
)

#: The tables whose surrogate key this store hands out — see
#: :meth:`Store.reserve`. ``event`` is the only one, and the tuple is what says
#: so: every other table is keyed by something the domain already names.
KEYED_TABLES = ('event',)

DEFAULT_ACCOUNT_ROW = ('default', 'Default account')


__all__ = ['DDL', 'TABLES', 'KEYED_TABLES', 'DEFAULT_ACCOUNT_ROW']
