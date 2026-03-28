export type EventType =
  | 'search'
  | 'download_started'
  | 'download_completed'
  | 'download_failed';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: EventType;
  data: Record<string, unknown>;
}

const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];

export function logActivity(type: EventType, data: Record<string, unknown>): void {
  if (events.length >= MAX_EVENTS) events.shift();
  events.push({
    id: Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    type,
    data,
  });
}

export function getEvents(): ActivityEvent[] {
  return events.slice().reverse();
}
