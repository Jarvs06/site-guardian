import { pino, type DestinationStream } from "pino";

export interface WorkerConfig {
  logLevel?: string;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

const HEARTBEAT_MS = 60_000;

/** Stage 1 shell: no jobs yet (Stage 2 adds pg-boss). Idles until stop(). */
export function startWorker(config: WorkerConfig, destination?: DestinationStream): Promise<WorkerHandle> {
  const logger = pino({ level: config.logLevel ?? "info" }, destination);
  logger.info("worker idle — no jobs in Stage 1");
  // The interval keeps the event loop alive until stop().
  let timer: NodeJS.Timeout | undefined = setInterval(() => logger.debug("worker heartbeat"), HEARTBEAT_MS);
  return Promise.resolve({
    stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
        logger.info("worker stopped");
      }
      return Promise.resolve();
    },
  });
}
