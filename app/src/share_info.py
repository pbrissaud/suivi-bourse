"""The per-symbol memory of Yahoo's ``info``, and who owns it (issue #847).

A *named* object rather than a bare dict, because two workloads write to it and
they do not write to it the same way. The scrape's live fetch **observes** a
symbol — a full payload, market state and trading period included — while the
backfill's lateral pass, having asked Yahoo for one thing only, may **learn** a
symbol it has never seen without ever overwriting what a live fetch put there.
The asymmetry is the whole design: a ``setdefault`` written by hand in one of
the two call sites is a line the next reader turns into an assignment, and the
richer entry disappears with it.

It is deliberately **not** a read of the store. ``symbol_quote`` carries neither
the market state nor the trading period, which is what the scheduling context is
read off, and it is a table rather than a memory of *this* process' fetches.
What lives here is a memory of the portfolio, not a fact about the market.

Constructed at one point — the runtime that holds both workloads — and handed to
each of them; neither builds one for itself.
"""
from typing import Dict, Iterator, Optional


class ShareInfoCache:
    """``symbol -> info``, with the two gestures named apart.

    The mapping half of it is read-only on purpose: a caller reads with
    ``get``/``[]``/``in``, and writes only through :meth:`observed` or
    :meth:`learned`, so there is no anonymous assignment for either sense to
    hide behind.
    """

    def __init__(self, entries: Optional[Dict[str, Dict]] = None):
        self._entries: Dict[str, Dict] = dict(entries or {})

    # -- the two gestures ------------------------------------------------ #

    def observed(self, symbol: str, info: Dict) -> None:
        """A live quote fetch saw this symbol: keep its payload, whole.

        It replaces whatever was there, and that is the point of the pair: this
        is the richest entry the app ever holds for a symbol.
        """
        self._entries[symbol] = info

    def learned(self, symbol: str, info: Dict) -> None:
        """A unit lookup answered for this symbol: fill the gap, overwrite nothing.

        ``setdefault``'s sense, said out loud (issue #773, #704): the lateral
        pass asks Yahoo what a symbol is quoted in, and what comes back is
        poorer than a live fetch's payload — so it is worth having only where
        there is nothing at all.
        """
        self._entries.setdefault(symbol, info)

    # -- the read half --------------------------------------------------- #

    def get(self, symbol: str, default=None):
        return self._entries.get(symbol, default)

    def __getitem__(self, symbol: str) -> Dict:
        return self._entries[symbol]

    def __contains__(self, symbol: object) -> bool:
        return symbol in self._entries

    def __iter__(self) -> Iterator[str]:
        return iter(self._entries)

    def __len__(self) -> int:
        return len(self._entries)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, ShareInfoCache):
            return self._entries == other._entries
        if isinstance(other, dict):
            return self._entries == other
        return NotImplemented

    __hash__ = None

    def __repr__(self) -> str:
        return f"ShareInfoCache({self._entries!r})"
