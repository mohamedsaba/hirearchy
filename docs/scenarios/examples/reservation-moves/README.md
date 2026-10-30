# A retry moved the booking backwards

Customers can move a booking to another session. Support reports that a failed
move can lose the original place, and an old retry can undo a newer successful
move. Fix the local move service while preserving the documented interfaces.

**Your task:** preserve seats and capacity, and make each accepted move replay
its own original result without moving the current booking again. The supplied
sender models a response lost before or after delivery. Confirmations describe the accepted move, not necessarily the latest location.
Everything is local
Python/pytest: no database, network, real email, clock, threads or process crashes.

## Public contract

`move(state, sender, account, reservation, destination, operation, recipient)`
returns a new dictionary with `reservation`, `from`, `to`, and `receipt`.
`State.transfer(account, reservation, destination)` returns the original slot.
Transferring directly to the current slot returns that slot without mutation, even
when the slot is full. Keep both signatures and Sender's contract. Any implementation meeting these
requirements is welcome; no particular architecture or investigation order is required.

1. Every reservation occupies exactly one slot, scoped by `(account, reservation)`.
   Slot capacities are global across accounts. Fixtures start consistent.
2. All five move arguments after sender must be nonempty strings; whitespace-only
   is invalid. Identifiers and recipients are opaque and case-sensitive, not normalized.
   Unknown reservation or destination rejects with ValueError before any state change
   or sender call. State.transfer must also reject unknown/full destinations safely.
3. A new move to a full destination rejects with ValueError. Reservation, operation
   history and sender remain unchanged. This rejected operation identity is not consumed;
   it can be retried after capacity becomes available. No reservation may be lost or
   any slot over capacity, including when State.transfer is called directly.
4. `(account, reservation, operation)` identifies one accepted intent and binds its
   original destination and recipient. An identical replay returns that operation's
   original `from`, `to` and receipt. A changed destination or recipient rejects without
   any state change or sender call. Different operation IDs may revisit the same slot.
5. Local acceptance commits the seat move AND preserves its original confirmation
   contents before calling Sender.deliver. A TimeoutError propagates; the accepted
   move stays committed even when that attempt delivered nothing. A replay may deliver
   the pending original confirmation using its original identity and contents.
6. A later operation can move that booking again. Retrying an older accepted operation
   must leave the CURRENT slot alone and return/confirm the older operation's original
   result. The sender guarantees idempotent replay of exact identity+payload; a reply
   lost after delivery must never create a second delivery.
7. Moving to the current slot is an accepted no-op: record the intent, return that
   slot as both from and to with receipt None, and do not call the sender. Replaying
   this no-op after later moves still has no effect; conflicting replay still rejects.
8. Returned result dictionaries must not let callers mutate accepted operation history.

Sender.deliver(key, payload) accepts any hashable key and a dictionary. Payload
contains account, reservation, from, to and recipient. Reusing a key with the exact
payload returns its existing integer receipt with no extra delivery; differing
payload rejects. `timeout_next='before'` or `'after'` injects one deterministic fault.
The sender is independent of State and must remain unchanged. Sender.calls counts
attempts; a safe rejected/no-op move does not contact it. Calls are sequential in
one surviving process; this task promises no production distributed durability.

## Incident sequence

- Start with a booking in A; B and C each have space.
- Request A -> B using operation `first`; sender times out after delivery.
- Request B -> C using operation `second`.
- Retry `first`: the booking must remain in C, but return the original A -> B receipt.

Another sequence: fill B, attempt A -> B, verify A still holds the booking; free
one place, then retry the SAME operation. These examples are reproducible in tests.

## Run and submit

Run `python3 -m pytest -q -p no:cacheprovider`. Editable files are src/state.py,
src/service.py and this README. Do not change sender.py, tests or public contracts.
Add a short handoff below: changed behavior, checks actually run and their results,
known limitations. A check plan is not a passing result. If your assessment disables
terminal access, explain which checks you could not run instead of inventing results.

## Handoff
