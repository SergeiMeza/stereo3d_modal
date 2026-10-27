"""Connection helper and schema bootstrap. Every session runs in UTC, so day buckets are UTC days."""
import os
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from . import config


@contextmanager
def connect():
    with psycopg.connect(config.DATABASE_URL, row_factory=dict_row) as conn:
        conn.execute("set time zone 'UTC'")
        yield conn


def migrate() -> None:
    with connect() as conn:
        for name in ("schema.sql", "views.sql"):
            with open(os.path.join(config.SQL_DIR, name), encoding="utf-8") as f:
                conn.execute(f.read())
        conn.execute(f"alter database {conn.info.dbname} set timezone = 'UTC'")
        conn.commit()
