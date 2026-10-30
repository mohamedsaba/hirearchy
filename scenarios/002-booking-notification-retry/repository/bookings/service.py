from .db import connect


def confirm_checkout(checkout_id, passenger_email, sailing):
    """Confirm a provider checkout and queue its passenger confirmation."""
    with connect() as connection:
        booking = connection.execute(
            "SELECT * FROM bookings WHERE checkout_id = ?", (checkout_id,)
        ).fetchone()
        if booking is None:
            cursor = connection.execute(
                "INSERT INTO bookings (checkout_id, passenger_email, sailing) VALUES (?, ?, ?)",
                (checkout_id, passenger_email, sailing),
            )
            booking_id = cursor.lastrowid
        else:
            booking_id = booking["id"]

        connection.execute(
            "INSERT INTO confirmations (booking_id, destination) VALUES (?, ?)",
            (booking_id, passenger_email),
        )
        return connection.execute(
            "SELECT * FROM bookings WHERE id = ?", (booking_id,)
        ).fetchone()


def list_bookings():
    with connect() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM bookings ORDER BY id")]


def list_confirmations():
    with connect() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM confirmations ORDER BY id")]
