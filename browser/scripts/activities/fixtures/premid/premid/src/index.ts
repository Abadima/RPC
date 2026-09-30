export enum ActivityType {
  Playing = 0,
  Watching = 3,
}

export function getTimestamps(time: number, duration: number): [number, number] {
  const start = Math.floor(Date.now() / 1000 - time);
  return [start, start + Math.floor(duration)];
}
