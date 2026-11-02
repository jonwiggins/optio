import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { logger } from "../logger.js";
import {
  claimQueuedSessionTurn,
  publishSessionQueue,
  finishSessionTurn,
} from "../services/session-turn-service.js";
import { runHarnessSession } from "../services/session-harness-service.js";
import { agentWorkPauseHold } from "../services/agent-work-pause.js";

/** Each replica may sweep. The session row lock and running-turn index elect one consumer. */
export function startSessionMessageWorker() {
  let stopped = false;
  let sweeping = false;
  const active = new Set<string>();
  const sweep = async () => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      // Agent work paused (services/agent-work-pause.ts): queued messages wait.
      if (await agentWorkPauseHold()) return;
      const rows = await db.execute<{ session_id: string }>(sql`
        SELECT DISTINCT q.session_id FROM session_chat_turns q
        JOIN interactive_sessions s ON s.id = q.session_id
        WHERE q.state = 'queued' AND s.state = 'active'
          AND NOT EXISTS (SELECT 1 FROM session_chat_turns r WHERE r.session_id = q.session_id AND r.state = 'running')
        LIMIT 100`);
      for (const { session_id: id } of rows) {
        if (stopped || active.has(id)) continue;
        active.add(id);
        void (async () => {
          const turn = await claimQueuedSessionTurn(id);
          if (!turn) return;
          try {
            await publishSessionQueue(id);
            await runHarnessSession(id, turn.prompt!, turn.requestId, turn);
          } catch (err) {
            await finishSessionTurn(turn.id, false);
            throw err;
          }
        })()
          .catch((err) => logger.error({ err, sessionId: id }, "Queued session turn failed"))
          .finally(() => active.delete(id));
      }
    } catch (err) {
      logger.error({ err }, "Session message queue sweep failed");
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), 1000);
  timer.unref();
  void sweep();
  return {
    close: async () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
