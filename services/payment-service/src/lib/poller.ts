/**
 * The one background-loop shape this service needs, used by the outbox
 * publisher, the settlement worker and the compensation worker.
 *
 * setTimeout rather than setInterval: a slow tick must not stack up behind
 * itself. A tick that throws is logged and retried on the next beat - these
 * loops are all built on `FOR UPDATE SKIP LOCKED`, so a failed attempt simply
 * leaves the row for the next pass.
 */
import { log } from './logger';

export interface Poller {
  stop: () => Promise<void>;
}

export function startPoller(
  name: string,
  intervalMs: number,
  tick: () => Promise<void>,
): Poller {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      log.error('poller tick failed, retrying next beat', { poller: name, err });
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };

  void run();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
