class State:
    def __init__(self, capacities, reservations):
        self.capacities = dict(capacities)
        self.reservations = dict(reservations)
        self.operations = {}

    def occupancy(self, slot):
        return sum(value == slot for value in self.reservations.values())

    def transfer(self, account, reservation, destination):
        key = (account, reservation)
        source = self.reservations.pop(key)
        if destination not in self.capacities:
            raise ValueError("Unknown destination")
        if self.occupancy(destination) >= self.capacities[destination]:
            raise ValueError("Destination full")
        self.reservations[key] = destination
        return source
