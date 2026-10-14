"""The name an Arrow block is bound under for the statement that reads it (#1198)."""

#: The name :meth:`store.Store.write_arrow` binds its Arrow table under, and
#: therefore the name the statement handed to it reads ``FROM``. Its own module
#: so the writers above the store can spell it without importing the store.
INCOMING = 'incoming'

__all__ = ['INCOMING']
