import os
import sqlite3


DEFAULT_DATABASE_PATH = "/tmp/north-pier-bookings.sqlite3"


def connect():
    connection = sqlite3.connect(
        os.environ.get("BOOKINGS_DATABASE", DEFAULT_DATABASE_PATH)
    )
    connection.row_factory = sqlite3.Row
    return connection


def initialize():
    with connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS bookings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                checkout_id TEXT NOT NULL UNIQUE,
                passenger_email TEXT NOT NULL,
                sailing TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'confirmed'
            );
            CREATE TABLE IF NOT EXISTS confirmations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                booking_id INTEGER NOT NULL REFERENCES bookings(id),
                destination TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
