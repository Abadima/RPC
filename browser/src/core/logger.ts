export interface Logger {
  info(message: string): void;
}

export function createLogger(appName: string): Logger {
  return {
    info(message: string): void {
      console.info(`[${appName}] ${message}`);
    },
  };
}
