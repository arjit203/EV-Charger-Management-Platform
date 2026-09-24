/**
 * Display labels for sessions that are live right now — so a real-time push can say WHERE.
 *
 * `session:statusChanged` used to carry only ids, so a charge that started while an operator was
 * watching /monitor appeared as "connector 1" with no station, charger or driver. Looking the
 * names up at emit time would make every emit async, and two quick transitions (initiating ->
 * active) could then arrive out of order. Instead the names are resolved ONCE, when the session is
 * created, and every later emit attaches them synchronously from here.
 *
 * In memory and bounded. A restart empties it; pushes then carry ids only and the browser keeps
 * the labels it already fetched over REST, so nothing breaks — it just degrades to the old shape.
 * Only for sessions still running: once a session ends, REST is the source again.
 */

export interface SessionLabels {
  companyName: string | null;
  stationName: string | null;
  stationAddress: string | null;
  stationCity: string | null;
  chargerName: string | null;
  powerKw: number | null;
  driverName: string | null;
  driverEmail: string | null;
}

const MAX_ENTRIES = 5_000;
const labels = new Map<string, SessionLabels>();

export function rememberSessionLabels(sessionId: string, value: SessionLabels): void {
  if (labels.size >= MAX_ENTRIES) {
    // Oldest first — Map preserves insertion order.
    const oldest = labels.keys().next().value;
    if (oldest !== undefined) labels.delete(oldest);
  }
  labels.set(sessionId, value);
}

export function labelsForSession(sessionId: string): SessionLabels | undefined {
  return labels.get(sessionId);
}

export function forgetSessionLabels(sessionId: string): void {
  labels.delete(sessionId);
}
