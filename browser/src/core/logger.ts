export interface Logger {
  info(message: string): void;
}

/** Dependency-free logging: every line is prefixed with the caller's app name. */
export function createLogger(appName: string): Logger {
  return {
    info(message: string): void {
      console.info(`[${appName}] ${message}`);
    },
  };
}
