/**
 * The orchestrator: preparer -> checker -> coordinator, then one appended `handoff_run` row.
 *
 * Three ordinary function calls in one process. No framework, no message bus, no chat: the
 * roles are separated by their inputs and their responsibilities, which is the part that
 * matters, not by transport.
 *
 *   prepare(context)              assemble the brief from what the CRM holds
 *   check(brief, context)         review it against the edition rules and the policy
 *   coordinate(brief, review, …)  decide ACCEPTED / PROVISIONAL / BLOCKED, and say why
 *
 * `executeHandoff` is pure — same context in, byte-identical role outputs out, which is what
 * tests/determinism.test.ts asserts. `runHandoff` is the same thing with the two impure ends
 * attached: read the context, append the row.
 */
import { pool } from "../db/pool";
import type { Id } from "../db/schema";
import { POLICY_VERSION } from "./policy";
import {
  type Db,
  insertRun,
  loadContextByCode,
  loadContextById,
  OpportunityNotFoundError,
  selectRun,
  selectRunsForOpportunity,
} from "./queries";
import { check } from "./roles/checker";
import { coordinate } from "./roles/coordinator";
import { prepare } from "./roles/preparer";
import type { HandoffContext, HandoffResult, HandoffRunRecord } from "./types";

export { OpportunityNotFoundError };
export type { Db };

/**
 * The three roles, in order, over a frozen context. Pure: no clock, no I/O, no randomness.
 */
export function executeHandoff(context: HandoffContext): HandoffResult {
  const brief = prepare(context);
  const review = check(brief, context);
  const decision = coordinate(brief, review, context);
  return { context, brief, review, decision };
}

/** How the caller names the opportunity: by legacy code, or by surrogate id. */
export type OpportunityRef = { opportunityCode: string } | { opportunityId: Id };

async function loadContext(db: Db, ref: OpportunityRef): Promise<HandoffContext> {
  return "opportunityCode" in ref
    ? loadContextByCode(db, ref.opportunityCode)
    : loadContextById(db, ref.opportunityId);
}

export interface RunOptions {
  /** Defaults to the shared pool; a transaction client can be passed in for tests. */
  db?: Db;
}

/**
 * Run the assistant and PERSIST the run.
 *
 * Append-only: this is the only write in the module and it is an INSERT. Re-running after
 * the brief has been edited adds a row; the earlier run keeps its own context snapshot,
 * role outputs, reason and policy version, and stays readable exactly as it was decided.
 */
export async function runHandoff(
  ref: OpportunityRef,
  options: RunOptions = {},
): Promise<HandoffRunRecord> {
  const db = options.db ?? pool;
  const context = await loadContext(db, ref);
  const { brief, review, decision } = executeHandoff(context);

  const { id, created_at } = await insertRun(db, {
    opportunity_id: context.opportunity_id,
    // The facts this run actually read, frozen. Stored rather than re-derived later.
    context_snapshot: context,
    brief,
    review,
    decision: decision.decision,
    decision_reason: decision.reason,
    policy_version: POLICY_VERSION,
  });

  return {
    id,
    opportunity_id: context.opportunity_id,
    opportunity_code: context.opportunity.opportunity_code,
    context_snapshot: context,
    brief,
    review,
    decision: decision.decision,
    decision_reason: decision.reason,
    policy_version: POLICY_VERSION,
    created_at,
  };
}

/**
 * Run the assistant WITHOUT persisting, for a preview screen. Identical logic; the only
 * difference is that nothing is written, so a preview can never be mistaken for a decision
 * that was taken.
 */
export async function previewHandoff(
  ref: OpportunityRef,
  options: RunOptions = {},
): Promise<HandoffResult> {
  const db = options.db ?? pool;
  return executeHandoff(await loadContext(db, ref));
}

/** Every run for an opportunity, newest first. */
export async function listHandoffRuns(
  opportunityId: Id,
  options: RunOptions & { limit?: number } = {},
): Promise<HandoffRunRecord[]> {
  const db = options.db ?? pool;
  return selectRunsForOpportunity(db, opportunityId, options.limit ?? 50);
}

/** The most recent run for an opportunity, or null when it has never been run. */
export async function latestHandoffRun(
  opportunityId: Id,
  options: RunOptions = {},
): Promise<HandoffRunRecord | null> {
  const runs = await listHandoffRuns(opportunityId, { ...options, limit: 1 });
  return runs[0] ?? null;
}

/** One stored run, by id, for the "revisit this run" screen. */
export async function getHandoffRun(
  runId: Id,
  options: RunOptions = {},
): Promise<HandoffRunRecord | null> {
  const db = options.db ?? pool;
  return selectRun(db, runId);
}

/** Read the context without running anything — for a "what would this see?" panel. */
export async function readHandoffContext(
  ref: OpportunityRef,
  options: RunOptions = {},
): Promise<HandoffContext> {
  const db = options.db ?? pool;
  return loadContext(db, ref);
}
