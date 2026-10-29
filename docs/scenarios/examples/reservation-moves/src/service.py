def move(state, sender, account, reservation, destination, operation, recipient):
    source = state.transfer(account, reservation, destination)
    payload = {"account": account, "reservation": reservation,
               "from": source, "to": destination, "recipient": recipient}
    receipt = sender.deliver((account, reservation), payload)
    state.operations[(account, reservation, operation)] = payload
    return {"reservation": reservation, "from": source,
            "to": destination, "receipt": receipt}
