"""Engine, session factory, and schema creation.

The connection URL is built with `URL.create`, never an f-string. The staged
MySQL password contains `?` and `#`, which start the query and fragment
components of a URL -- a hand-built DSN silently truncates the password there
and MySQL answers "Access denied" with nothing to suggest why.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings
from app.models import Base

log = logging.getLogger(__name__)
slow_log = logging.getLogger("app.db.slow")


def build_url(s: Settings) -> URL:
    return URL.create(
        drivername="mysql+pymysql",
        username=s.MYSQL_USER,
        password=s.MYSQL_PASSWORD.get_secret_value(),   # raw; URL.create encodes it
        host=s.MYSQL_HOST,
        port=s.MYSQL_PORT,
        database=s.MYSQL_DATABASE,   # hyphens are legal in a URL path segment
        query={"charset": "utf8mb4"},
    )


def build_engine(s: Settings) -> Engine:
    engine = create_engine(
        build_url(s),
        pool_size=s.MYSQL_POOL_SIZE,
        max_overflow=5,
        pool_recycle=s.MYSQL_POOL_RECYCLE,   # must stay under RDS wait_timeout
        pool_pre_ping=True,                  # survives idle kills and failovers
        pool_timeout=10,
        future=True,
    )
    _install_slow_query_log(engine, s.MYSQL_SLOW_QUERY_MS)
    return engine


def _install_slow_query_log(engine: Engine, threshold_ms: int) -> None:
    """Warn about queries slower than the threshold. RDS is across a network,
    so this is worth having. Logs the statement only -- the bind parameters
    hold password hashes, token fingerprints and email addresses."""

    @event.listens_for(engine, "before_cursor_execute")
    def _start(conn, cursor, statement, parameters, context, executemany):
        conn.info.setdefault("_q_start", []).append(time.perf_counter())

    @event.listens_for(engine, "after_cursor_execute")
    def _end(conn, cursor, statement, parameters, context, executemany):
        stack = conn.info.get("_q_start")
        if not stack:
            return
        elapsed_ms = (time.perf_counter() - stack.pop()) * 1000
        if elapsed_ms >= threshold_ms:
            slow_log.warning("slow query %.0fms: %s", elapsed_ms,
                             " ".join(statement.split())[:400])


_settings = get_settings()
engine: Engine = build_engine(_settings)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False,
                            future=True)


def get_db() -> Iterator[Session]:
    """FastAPI dependency. One session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_schema(bind: Engine | None = None) -> None:
    """Create any missing tables.

    Note what this does not do: it never ALTERs an existing table. Adding a
    column later means running the ALTER by hand or adopting Alembic then.
    """
    target = bind or engine
    try:
        Base.metadata.create_all(bind=target)
    except (OperationalError, ProgrammingError) as exc:
        log.critical(
            "Could not create tables in %r as %r. Check the database exists, the "
            "credentials are right, this host can reach it, and the user holds "
            "CREATE privileges. Underlying error: %s",
            _settings.MYSQL_DATABASE, _settings.MYSQL_USER, exc,
        )
        raise


def ping(bind: Engine | None = None) -> None:
    """Raise if the database is unreachable. Used by /readyz."""
    with (bind or engine).connect() as conn:
        conn.execute(text("SELECT 1"))


if __name__ == "__main__":   # python -m app.db -- create tables and seed the admin
    from app.bootstrap import seed_admin

    logging.basicConfig(level=_settings.LOG_LEVEL,
                        format="%(levelname)s %(name)s: %(message)s")
    log.info("connecting to %s:%s/%s as %s", _settings.MYSQL_HOST, _settings.MYSQL_PORT,
             _settings.MYSQL_DATABASE, _settings.MYSQL_USER)
    ping()
    create_schema()
    log.info("tables present: %s", ", ".join(sorted(Base.metadata.tables)))
    with SessionLocal() as db:
        seed_admin(db, _settings)
