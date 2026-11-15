"""Exact equal-cost road routing. Never snaps fractional positions silently."""
from collections import deque
from dataclasses import dataclass
from .contracts import FarmMap

Cell = tuple[int, int]


@dataclass(frozen=True)
class RouteResult:
    reachable: bool
    path: tuple[Cell, ...]
    distance_cells: int | None
    travel_min: float | None
    reason: str | None


class RoadRouter:
    def __init__(self, farm: FarmMap, map_version: int):
        self.farm = farm.model_copy(deep=True)
        self.map_version = map_version
        self._trees = {}
        blocked = set(farm.blocked_cells)
        self.cells = {
            (x, y) for x in range(farm.grid.width) for y in range(farm.grid.height)
            if (y in farm.roads.rows or x in farm.roads.cols) and (x, y) not in blocked
        }

    def route(self, start, goal, speed_cells_per_min: float) -> RouteResult:
        if speed_cells_per_min <= 0:
            raise ValueError('Speed must be positive')
        if any(not float(v).is_integer() for p in (start, goal) for v in p):
            return RouteResult(False, (), None, None, 'fractional_position_requires_gateway_connector')
        start, goal = tuple(map(int, start)), tuple(map(int, goal))
        if start not in self.cells or goal not in self.cells:
            return RouteResult(False, (), None, None, 'endpoint_not_on_available_road')
        if start not in self._trees:
            parents = {start: None}
            queue = deque([start])
            while queue:
                x, y = queue.popleft()
                for nxt in ((x+1, y), (x, y+1), (x-1, y), (x, y-1)):
                    if nxt in self.cells and nxt not in parents:
                        parents[nxt] = (x, y)
                        queue.append(nxt)
            self._trees[start] = parents
        parents = self._trees[start]
        if goal not in parents:
            return RouteResult(False, (), None, None, 'no_path')
        path = []
        cur = goal
        while cur is not None:
            path.append(cur)
            cur = parents[cur]
        path.reverse()
        distance = len(path)-1
        return RouteResult(True, tuple(path), distance, distance/speed_cells_per_min, None)
