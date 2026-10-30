# North Pier booking notifications

North Pier Ferries takes bookings online for two island routes. The operations
team has received reports that some passengers see more than one confirmation
for a single checkout. The payment provider can retry delivery when it does
not receive an acknowledgement promptly.

Explore the service, make a change that addresses the reported behavior, and
verify it with the supplied tests. The workspace contains a small Flask
application backed by SQLite. Run `pytest` from the repository root. The
service is available at `http://127.0.0.1:8000` inside the workspace.

You may choose the investigation and implementation approach. Keep the
existing booking behavior working for distinct checkouts and explain your
change in the submitted code.
