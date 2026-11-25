export type KeyedLimiter = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Runs at most `perKey` tasks per key and `total` tasks overall. Waiting tasks start in FIFO order
 * within a key; keys are served in the order they first queued. A task whose slot is free starts
 * synchronously inside the call.
 */
export function createKeyedLimiter(perKey: number, total: number): KeyedLimiter {
  let active = 0;
  const activeByKey = new Map<string, number>();
  const waiting = new Map<string, (() => void)[]>();

  const pump = (): void => {
    for (const [key, queue] of waiting) {
      if (active >= total) return;
      while (queue.length > 0 && active < total && (activeByKey.get(key) ?? 0) < perKey) {
        queue.shift()?.();
      }
      if (queue.length === 0) waiting.delete(key);
    }
  };

  return <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++;
        activeByKey.set(key, (activeByKey.get(key) ?? 0) + 1);
        const release = (): void => {
          active--;
          const left = (activeByKey.get(key) ?? 1) - 1;
          if (left === 0) activeByKey.delete(key);
          else activeByKey.set(key, left);
          pump();
        };
        let run: Promise<T>;
        try {
          run = fn();
        } catch (err) {
          run = Promise.reject(err as Error);
        }
        run.then(
          (value) => {
            release();
            resolve(value);
          },
          (err: unknown) => {
            release();
            reject(err as Error);
          },
        );
      };
      const queue = waiting.get(key);
      if (queue) queue.push(start);
      else waiting.set(key, [start]);
      pump();
    });
}
