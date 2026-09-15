/**
 * Public surface of the handoff assistant. The UI imports from here and from nowhere else
 * inside `src/handoff`.
 *
 *   import { runHandoff, listHandoffRuns, MODEL_STAND_IN, POLICY_SUMMARY } from "@/handoff";
 *
 * Everything exported is either a plain function over the database pool or a constant. There
 * is no client to construct, no key to configure and nothing to await at module load.
 */

/* The orchestrator and the persistence surface. */
export {
  executeHandoff,
  getHandoffRun,
  latestHandoffRun,
  listHandoffRuns,
  OpportunityNotFoundError,
  previewHandoff,
  readHandoffContext,
  runHandoff,
} from "./run";
export type { Db, OpportunityRef, RunOptions } from "./run";

/* The roles, exported individually so a caller can run one in isolation — and so the three
 * are visibly three things rather than one function with a comment. */
export { prepare, BRIEF_VERSION } from "./roles/preparer";
export { check, SEVERITY_ORDER } from "./roles/checker";
export { coordinate, DECISION_PRECEDENCE } from "./roles/coordinator";

/* The policy, for the UI panel that explains why a decision came out as it did. */
export { POLICY_VERSION, POLICY_SUMMARY, checkHeight, evaluatePolicy } from "./policy";
export type { PolicyEvaluation } from "./policy";

/* The stand-in's label. Render this next to any generated text: it is a stand-in, and the
 * UI has to say so. */
export { MODEL_STAND_IN, MODEL_STAND_IN_BADGE, MODEL_STAND_IN_LABEL } from "./model";

/* Formatting, so the UI renders NUMERIC strings the same way the reasons do and never puts
 * a euro amount or a height through a float. */
export {
  compareDecimal,
  formatDate,
  formatEuro,
  formatMetres,
  formatSquareMetres,
} from "./decimal";

export { CONTEXT_SNAPSHOT_VERSION, SEVERITIES } from "./types";
export type {
  Brief,
  BriefActivityLine,
  BriefFact,
  BriefUnknown,
  ContextActivity,
  ContextCompany,
  ContextContact,
  ContextFairEdition,
  ContextOpportunity,
  Decision,
  Finding,
  GateName,
  GateResult,
  HandoffContext,
  HandoffDecision,
  HandoffResult,
  HandoffRunRecord,
  HeightCheck,
  HeightCheckStatus,
  ModelStamp,
  Outstanding,
  ProposedNextStep,
  Review,
  Severity,
} from "./types";
