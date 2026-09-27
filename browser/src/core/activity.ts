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

export interface Activity {
  id: string;
  name: string;
  details?: string;
  state?: string;
  url: string;
  assets?: ActivityAssets;
  timestamps?: ActivityTimestamps;
}
