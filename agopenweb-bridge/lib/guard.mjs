// Safety guard for real AgOpenWeb tractors (pure, testable).
// Why: when a container is overloaded its HostLoop stalls, our control.presence heartbeat gaps exceed the
// ~1.7 s deadman, AgOpenWeb drops autosteer (and our control) but the simulator keeps its speed, so the
// tractor drives straight off the farm. The bridge checks every real Tick:
//  - 'geofence'  pose outside the farm (grid, with a margin) while moving -> stop + autosteer off + demote
//  - 'reengage'  on a job, not manual, but autosteer or control lost for > graceMs -> re-acquire + resume
//  - null        all good

export const GEOFENCE_MARGIN_CELLS = 0.6;

export function insideFarm(g, grid, margin = GEOFENCE_MARGIN_CELLS) {
  return !!g && g.x >= -0.5 - margin && g.x <= grid.width - 0.5 + margin && g.y >= -0.5 - margin && g.y <= grid.height - 0.5 + margin;
}

/** @param s { g:{x,y}, grid:{width,height}, speedMps, working, manual, autosteer, hasControl, lostSince, now, graceMs? } */
export function guardDecision(s) {
  if (!s.g) return null;
  if (!insideFarm(s.g, s.grid) && (s.speedMps || 0) > 0.05) return 'geofence';
  if (s.working && !s.manual && (!s.autosteer || !s.hasControl) && s.lostSince != null && s.now - s.lostSince > (s.graceMs ?? 2500)) return 'reengage';
  return null;
}
