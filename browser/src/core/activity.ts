export interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

/** What the dashboard's Activities page lists: one entry per registered Activity. */
export interface ActivityInfo {
  id: string;
  name: string;
  description?: string;
  /** The sites it recognizes, for display and search, e.g. `youtube.com`. */
  hosts: string[];
  /** The Discord Application it shows as, like each PreMiD Activity has its own. */
  discordClientId?: string;
}

export interface Activity {
  id: string;
  name: string;
  details?: string;
  state?: string;
  url: string;
  assets?: ActivityAssets;
  timestamps?: ActivityTimestamps;
}
