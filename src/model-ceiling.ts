import type { Conversation, Store } from './store.js';
import type { Backend } from './util.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * How strong a model is, from its name, on one scale for both CLIs (a sub-agent may run on the other one): 0 small
 * (haiku, *-mini), 1 mid (sonnet), 2 large (opus, gpt-*), 3 (fable). null: a name it does not know.
 */
export function modelTier(slug: string): number | null {
  const s = slug.toLowerCase();
  if (/haiku|-mini|-nano|spark/.test(s)) return 0;
  if (s.includes('sonnet')) return 1;
  if (s.includes('fable')) return 3;
  if (/opus|codex|^gpt-|^o\d/.test(s)) return 2;
  return null;
}

/** What a chat runs with: its own model/effort, else the panel's default, else (null) its CLI's own, which nobody here knows. */
export type Run = { backend: Backend; model: string | null; effort: string | null };
export const runOf = (store: Store, c: Pick<Conversation, 'model' | 'effort' | 'backend'>): Run => ({
  backend: c.backend, model: c.model || store.getDefaultModel(c.backend) || null, effort: c.effort || store.getDefaultEffort(c.backend) || null,
});

/**
 * Why a chat may not run on `want`'s model under `cap` (the agent that starts or runs it), or null: never a stronger
 * one. A model left to the CLI is the same only on the same CLI; anywhere else it cannot be compared, so it is refused.
 */
export function refuseModel(want: Run, cap: Run): string | null {
  const sameCli = want.backend === cap.backend;
  if (want.model === cap.model && (want.model !== null || sameCli)) return null;
  const w = want.model ? modelTier(want.model) : null;
  const c = cap.model ? modelTier(cap.model) : null;
  if (w === null || c === null) {
    return `cannot tell whether ${want.model ?? `${want.backend}'s default model`} is above your own model (${cap.model ?? `${cap.backend}'s default`}): `
      + (sameCli ? 'leave model out to run on yours, or pick one list_models gives you' : 'pick a model list_models gives you');
  }
  return w > c ? `model ${want.model} is above your own (${cap.model}): a sub-agent may not run on a stronger model than you` : null;
}

/** The same for the effort; the lowest one is always allowed, nothing is below it. */
export function refuseEffort(want: Run, cap: Run): string | null {
  if (want.effort === EFFORTS[0] || (want.effort === cap.effort && (want.effort !== null || want.backend === cap.backend))) return null;
  if (want.effort === null || cap.effort === null) {
    return `cannot tell whether effort ${want.effort ?? `${want.backend}'s default`} is above your own (${cap.effort ?? `${cap.backend}'s default`}): `
      + `give effort ${cap.effort ?? EFFORTS[0]}`;
  }
  return EFFORTS.indexOf(want.effort as never) > EFFORTS.indexOf(cap.effort as never) ? `effort ${want.effort} is above your own (${cap.effort})` : null;
}

/** Why a chat may not run with `want` under `cap`, or null. Outside clients (no `cap`) may pick anything. */
export function refuseChoice(want: Run, cap: Run | null): string | null {
  return cap ? refuseModel(want, cap) ?? refuseEffort(want, cap) : null;
}

/** A sub-agent's turn that may not run at all: its parent gets the reason as the report. */
export class CeilingError extends Error {}
