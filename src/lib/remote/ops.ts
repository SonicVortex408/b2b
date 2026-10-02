/**
 * Server-side operations. Load → authorize → run the same action as the browser → diff →
 * apply_engine_changes() (transactional, guarded by the EXCLUDE constraint). A 23P01 means someone
 * else won the race; we reload and let the engine decide again (bump / negotiate / alternatives).
 */
import { ActionError, authorize, runAction, type Action, type Actor } from "@/lib/actions";
import type * as E from "@/lib/engine";
import type { BookResult } from "@/lib/types";
import { diff, isEmpty, type Changes } from "./mapping";

export type { ActKind, Actor } from "@/lib/actions";
export type Op = Action;
export { ActionError as OpError };

export interface Storage {
  load(): Promise<E.EngineState>;
  apply(c: Changes): Promise<{ ok: boolean; code?: string; detail?: string }>;
}

export interface OpResult {
  result?: BookResult;
  message?: string;
  text?: string;
  attempts: number;
}

export async function applyOp(storage: Storage, op: Op, actor: Actor, ctx: E.RuleContext, maxAttempts = 3): Promise<OpResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const s = await storage.load();
    const allowed = authorize(op, actor, s);
    const before = structuredClone(s);
    const out = runAction(s, allowed, actor, ctx);
    const changes = diff(before, s, actor.name, actor.id);
    const text = s.events[0] && s.events[0] !== before.events[0] ? s.events[0].text : undefined;
    if (isEmpty(changes)) return { ...out, text, attempts: attempt };
    const res = await storage.apply(changes);
    if (res.ok) return { ...out, text, attempts: attempt };
    if (res.code !== "23P01") throw new ActionError(500, res.detail ?? "Database error");
    // Lost a race: another request took the slot between our load and our write. Re-decide.
  }
  throw new ActionError(409, "The room was taken by concurrent requests; please retry.");
}
