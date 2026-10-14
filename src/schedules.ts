import type { FastifyInstance } from 'fastify';
import { CronError, nextRun, parseCron } from './cron.js';
import type { Dispatcher } from './dispatcher.js';
import type { Schedule, Store } from './store.js';

/** The server's time zone: cron expressions are read in it. */
export const serverTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Queue a schedule's prompt into its chat, like a person pressing Send. Returns false when the same prompt from an
 * earlier run is still waiting in the queue: a busy chat gets one pending copy, not a pile.
 */
export function runSchedule(store: Store, dispatcher: Dispatcher, s: Schedule): boolean {
  if (store.listQueue(s.conversation_id).some((q) => q.prompt === s.prompt)) return false;
  store.enqueue(s.conversation_id, s.prompt, [], s.created_by);
  dispatcher.kick(s.conversation_id);
  return true;
}

/**
 * Checks for due schedules every `everyMs`. Runs missed while the gateway was down are not caught up one by one: a
 * schedule that is overdue runs once, then waits for its next time from now.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store, private dispatcher: Dispatcher) {}

  start(everyMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run what is due at `now`; returns the ids of the schedules that ran. */
  tick(now = Date.now()): number[] {
    const ran: number[] = [];
    for (const s of this.store.dueSchedules(now)) {
      let next: number | null = null;
      try { next = nextRun(parseCron(s.cron), now); } catch { /* saved before a parser change: switch it off below */ }
      try {
        if (runSchedule(this.store, this.dispatcher, s)) ran.push(s.id);
      } catch (e) {
        console.error(`schedule ${s.id} failed to run`, e);
      }
      this.store.markScheduleRun(s.id, now, next);
    }
    return ran;
  }
}

/** The next `count` run times of an expression, or a CronError. */
function upcoming(cron: string, from: number, count: number): number[] {
  const c = parseCron(cron);
  const out: number[] = [];
  for (let t: number | null = from; out.length < count;) {
    t = nextRun(c, t);
    if (t === null) break;
    out.push(t);
  }
  if (!out.length) throw new CronError('this schedule never runs');
  return out;
}

const scheduleBody = {
  prompt: { type: 'string', minLength: 1, maxLength: 100_000, pattern: '\\S' },
  cron: { type: 'string', minLength: 1, maxLength: 200 },
  enabled: { type: 'boolean' },
} as const;

/** Scheduled prompts. Anyone who may send a prompt into a chat may schedule one there. */
export function scheduleRoutes(app: FastifyInstance, deps: { store: Store; dispatcher: Dispatcher }): void {
  const { store, dispatcher } = deps;
  const notFound = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send({ error: 'not found' });
  const withNames = (id: number) => store.listSchedules().find((s) => s.id === id);

  app.get('/api/schedules', () => store.listSchedules());

  // For the form: when an expression would run, in which time zone, or why it is not valid.
  app.get<{ Querystring: { cron: string } }>('/api/schedules/preview', {
    schema: { querystring: { type: 'object', required: ['cron'], properties: { cron: { type: 'string', maxLength: 200 } } } },
  }, (req, reply) => {
    try {
      return { next: upcoming(req.query.cron, Date.now(), 3), timeZone: serverTimeZone() };
    } catch (e) {
      if (e instanceof CronError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/schedules', (req, reply) =>
    store.getConversation(req.params.id) ? store.listSchedules(req.params.id) : notFound(reply));

  app.post<{ Params: { id: string }; Body: { prompt: string; cron: string; enabled?: boolean } }>('/api/conversations/:id/schedules', {
    schema: { body: { type: 'object', required: ['prompt', 'cron'], additionalProperties: false, properties: scheduleBody } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    try {
      const [next] = upcoming(req.body.cron, Date.now(), 1);
      const s = store.createSchedule(req.params.id, {
        prompt: req.body.prompt.trim(), cron: req.body.cron.trim(), enabled: req.body.enabled ?? true, nextRunAt: next!, createdBy: req.user!.name,
      });
      return reply.code(201).send(withNames(s.id));
    } catch (e) {
      if (e instanceof CronError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: { prompt?: string; cron?: string; enabled?: boolean } }>('/api/schedules/:id', {
    schema: { body: { type: 'object', minProperties: 1, additionalProperties: false, properties: scheduleBody } },
  }, (req, reply) => {
    const s = store.getSchedule(Number(req.params.id));
    if (!s) return notFound(reply);
    const cron = req.body.cron?.trim() ?? s.cron;
    try {
      const [next] = upcoming(cron, Date.now(), 1);
      store.updateSchedule(s.id, { prompt: req.body.prompt?.trim() ?? s.prompt, cron, enabled: req.body.enabled ?? s.enabled, nextRunAt: next! });
      return withNames(s.id);
    } catch (e) {
      if (e instanceof CronError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', (req, reply) =>
    store.deleteSchedule(Number(req.params.id)) ? reply.code(204).send() : notFound(reply));

  // Run it now, off its schedule (its next scheduled time stays as it was).
  app.post<{ Params: { id: string } }>('/api/schedules/:id/run', (req, reply) => {
    const s = store.getSchedule(Number(req.params.id));
    if (!s) return notFound(reply);
    if (!runSchedule(store, dispatcher, s)) return reply.code(409).send({ error: 'this prompt is already waiting in the chat\'s queue' });
    return reply.code(202).send({ queued: true });
  });
}
