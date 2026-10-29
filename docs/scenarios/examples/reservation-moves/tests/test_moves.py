from copy import deepcopy
import pytest
from src.state import State
from src.sender import Sender
from src.service import move


def setup():
    return State({"A": 2, "B": 1, "C": 2}, {("acct", "r1"): "A"}), Sender()


def snapshot(state, sender):
    return deepcopy((state.reservations, state.operations, sender.deliveries, sender.calls))


def conserved(state, count):
    assert len(state.reservations) == count
    assert all(slot in state.capacities for slot in state.reservations.values())
    assert all(state.occupancy(slot) <= cap for slot, cap in state.capacities.items())


def test_full_destination_preserves_original_seat_and_does_not_consume_intent():
    state, sender = setup()
    state.reservations[("other", "r2")] = "B"
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert snapshot(state, sender) == before
    state.transfer("other", "r2", "C")
    result = move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert result == {"reservation": "r1", "from": "A", "to": "B", "receipt": 1}
    conserved(state, 2)


def test_direct_transfer_rejection_is_safe_and_same_slot_is_noop():
    state, sender = setup()
    state.reservations[("other", "r2")] = "B"
    before = snapshot(state, sender)
    for destination in ("B", "unknown"):
        with pytest.raises(ValueError): state.transfer("acct", "r1", destination)
        assert snapshot(state, sender) == before
    with pytest.raises(ValueError): state.transfer("acct", "missing", "A")
    assert snapshot(state, sender) == before
    assert state.transfer("other", "r2", "B") == "B"
    assert snapshot(state, sender) == before


@pytest.mark.parametrize("fault", ["before", "after"])
def test_ambiguous_confirmation_keeps_local_acceptance_and_replays_original(fault):
    state, sender = setup()
    sender.timeout_next = fault
    with pytest.raises(TimeoutError): move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert state.reservations[("acct", "r1")] == "B"
    second = move(state, sender, "acct", "r1", "C", "second", "Grace")
    assert second["from"] == "B" and second["to"] == "C"
    first = move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert first["from"] == "A" and first["to"] == "B"
    assert state.reservations[("acct", "r1")] == "C"
    assert len(sender.deliveries) == 2
    expected_payload = {"account": "acct", "reservation": "r1", "from": "A", "to": "B", "recipient": "Ada"}
    original_delivery = [(payload, receipt) for payload, receipt in sender.deliveries.values()
                         if payload["from"] == "A" and payload["to"] == "B"]
    assert original_delivery == [(expected_payload, first["receipt"])]
    assert first == move(state, sender, "acct", "r1", "B", "first", "Ada")
    conserved(state, 1)


def test_old_replay_does_not_check_current_capacity_or_undo_a_new_move():
    state, sender = setup()
    first = move(state, sender, "acct", "r1", "B", "first", "Ada")
    move(state, sender, "acct", "r1", "C", "second", "Grace")
    state.reservations[("other", "r2")] = "B"
    assert move(state, sender, "acct", "r1", "B", "first", "Ada") == first
    assert state.reservations[("acct", "r1")] == "C"
    conserved(state, 2)


@pytest.mark.parametrize("changed", [("C", "Ada"), ("B", "Grace")])
def test_conflicting_accepted_replay_preserves_all_state(changed):
    state, sender = setup()
    move(state, sender, "acct", "r1", "B", "first", "Ada")
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, "acct", "r1", changed[0], "first", changed[1])
    assert snapshot(state, sender) == before


def test_scoped_operations_and_repeated_visits_remain_distinct():
    state = State({"A": 4, "B": 4}, {("acct", "r1"): "A", ("other", "r1"): "A", ("acct", "r2"): "A"})
    sender = Sender()
    for account, reservation in state.reservations.copy():
        move(state, sender, account, reservation, "B", "same", "Ada")
    move(state, sender, "acct", "r1", "A", "back", "Ada")
    move(state, sender, "acct", "r1", "B", "again", "Ada")
    assert len(sender.deliveries) == 5
    conserved(state, 3)


def test_noop_is_historical_and_sends_nothing_even_after_later_move():
    state, sender = setup()
    noop = move(state, sender, "acct", "r1", "A", "stay", "Ada")
    assert noop == {"reservation": "r1", "from": "A", "to": "A", "receipt": None}
    assert sender.calls == 0
    move(state, sender, "acct", "r1", "B", "first", "Ada")
    before = snapshot(state, sender)
    assert move(state, sender, "acct", "r1", "A", "stay", "Ada") == noop
    assert snapshot(state, sender) == before
    with pytest.raises(ValueError): move(state, sender, "acct", "r1", "B", "stay", "Ada")
    assert snapshot(state, sender) == before


@pytest.mark.parametrize("index", range(5))
@pytest.mark.parametrize("invalid", ["", "  ", None, 123])
def test_invalid_arguments_have_no_effect(index, invalid):
    state, sender = setup()
    args = ["acct", "r1", "B", "first", "Ada"]
    args[index] = invalid
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, *args)
    assert snapshot(state, sender) == before


@pytest.mark.parametrize("account,reservation,destination", [("missing", "r1", "B"), ("acct", "missing", "B"), ("acct", "r1", "missing")])
def test_unknown_identifiers_have_no_effect(account, reservation, destination):
    state, sender = setup()
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, account, reservation, destination, "first", "Ada")
    assert snapshot(state, sender) == before


def test_case_sensitive_identity_and_returned_result_is_not_history_alias():
    state = State({"A": 2, "B": 2}, {("Acct", "r1"): "A", ("acct", "r1"): "A"})
    sender = Sender()
    result = move(state, sender, "Acct", "r1", "B", "first", "Ada")
    result["to"] = "broken"
    replay = move(state, sender, "Acct", "r1", "B", "first", "Ada")
    assert replay["to"] == "B"
    move(state, sender, "acct", "r1", "B", "first", "Ada")
    assert len(sender.deliveries) == 2


def test_conflicting_retry_after_before_delivery_timeout_is_rejected_without_effect():
    state, sender = setup()
    sender.timeout_next = "before"
    with pytest.raises(TimeoutError): move(state, sender, "acct", "r1", "B", "first", "Ada")
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, "acct", "r1", "B", "first", "Grace")
    assert snapshot(state, sender) == before


def test_noop_recipient_conflict_is_rejected_without_effect():
    state, sender = setup()
    move(state, sender, "acct", "r1", "A", "stay", "Ada")
    before = snapshot(state, sender)
    with pytest.raises(ValueError): move(state, sender, "acct", "r1", "A", "stay", "Grace")
    assert snapshot(state, sender) == before
