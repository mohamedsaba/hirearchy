import os
import tempfile

import pytest


@pytest.fixture
def client(monkeypatch):
    database = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
    database.close()
    monkeypatch.setenv("BOOKINGS_DATABASE", database.name)

    from bookings.db import initialize
    from app import app

    initialize()
    app.config.update(TESTING=True)
    with app.test_client() as test_client:
        yield test_client
    os.unlink(database.name)
