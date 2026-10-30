from copy import deepcopy


class Sender:
    """Local upstream contract. Keys bind exact payloads; replay is idempotent.
    timeout_next can be 'before' or 'after' delivery, consumed on first attempt.
    No clocks, threads, network, email or crash durability are involved.
    """
    def __init__(self, timeout_next=None):
        self.deliveries = {}
        self.timeout_next = timeout_next
        self.calls = 0

    def deliver(self, key, payload):
        self.calls += 1
        if key in self.deliveries:
            original, receipt = self.deliveries[key]
            if original != payload:
                raise ValueError("Conflicting replay")
            return receipt
        fault, self.timeout_next = self.timeout_next, None
        if fault == "before":
            raise TimeoutError("Response unavailable before delivery")
        receipt = len(self.deliveries) + 1
        self.deliveries[key] = (deepcopy(payload), receipt)
        if fault == "after":
            raise TimeoutError("Response lost after delivery")
        return receipt
