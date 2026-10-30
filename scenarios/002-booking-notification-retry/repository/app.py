from flask import Flask, jsonify, request

from bookings.db import initialize
from bookings.service import confirm_checkout, list_bookings, list_confirmations

app = Flask(__name__)
initialize()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/provider/checkouts/<checkout_id>/confirm")
def provider_confirmation(checkout_id):
    payload = request.get_json(silent=True) or {}
    passenger_email = payload.get("passenger_email")
    sailing = payload.get("sailing")
    if not isinstance(passenger_email, str) or not passenger_email.strip():
        return jsonify({"error": "passenger_email is required"}), 400
    if not isinstance(sailing, str) or not sailing.strip():
        return jsonify({"error": "sailing is required"}), 400

    booking = confirm_checkout(checkout_id, passenger_email.strip(), sailing.strip())
    return jsonify({"booking": dict(booking)}), 200


@app.get("/bookings")
def bookings():
    return jsonify({"bookings": list_bookings()})


@app.get("/confirmations")
def confirmations():
    return jsonify({"confirmations": list_confirmations()})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=False)
