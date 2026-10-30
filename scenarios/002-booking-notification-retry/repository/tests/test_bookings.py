def payload(email="sam@example.test", sailing="North Pier → Greyhaven, 09:30"):
    return {"passenger_email": email, "sailing": sailing}


def test_provider_retry_does_not_duplicate_booking_or_confirmation(client):
    first = client.post("/provider/checkouts/chk-1042/confirm", json=payload())
    retry = client.post("/provider/checkouts/chk-1042/confirm", json=payload())

    assert first.status_code == 200
    assert retry.status_code == 200
    assert first.json["booking"]["id"] == retry.json["booking"]["id"]
    assert len(client.get("/bookings").json["bookings"]) == 1
    assert len(client.get("/confirmations").json["confirmations"]) == 1


def test_distinct_checkouts_for_same_passenger_remain_distinct(client):
    client.post("/provider/checkouts/chk-1042/confirm", json=payload())
    client.post("/provider/checkouts/chk-1043/confirm", json=payload())

    assert len(client.get("/bookings").json["bookings"]) == 2
    assert len(client.get("/confirmations").json["confirmations"]) == 2


def test_confirmation_rejects_missing_sailing(client):
    response = client.post(
        "/provider/checkouts/chk-1042/confirm",
        json={"passenger_email": "sam@example.test"},
    )

    assert response.status_code == 400
    assert client.get("/bookings").json["bookings"] == []
