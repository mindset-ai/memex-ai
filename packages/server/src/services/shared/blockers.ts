import { getTask } from "../tasks.js";
import { getDecision } from "../decisions.js";
import {
  addDecisionDep,
  removeDecisionDep,
  addTaskDep,
  removeTaskDep,
} from "../dependencies.js";
import { parseHandle } from "./identifiers.js";
import { ValidationError } from "../../types/errors.js";
import type { Mutated } from "../mutate.js";

/**
 * Parse a blocker handle ("dec-N" or "t-N"), resolve the referenced entity,
 * and add the dependency. Throws ValidationError for invalid formats.
 *
 * Returns the `Mutated<void>` brand produced by the underlying dependency
 * write so the compile-time "went through mutate()" guarantee survives this
 * orchestrator boundary (spec-156 ac-20).
 */
export async function addBlocker(
  memexId: string,
  taskId: string,
  blockedBy: string
): Promise<Mutated<void>> {
  const item = await getTask(memexId, taskId);

  if (parseHandle(blockedBy, "D-") !== null) {
    const dec = await getDecision(memexId, blockedBy, item.docId);
    return addDecisionDep(memexId, taskId, dec.id);
  } else if (parseHandle(blockedBy, "T-") !== null) {
    const depItem = await getTask(memexId, blockedBy, item.docId);
    return addTaskDep(memexId, taskId, depItem.id);
  } else {
    throw new ValidationError(
      `Invalid blocker format: "${blockedBy}". Use "D-N" for a decision or "T-N" for a task.`
    );
  }
}

/**
 * Parse a blocker handle ("D-N" or "T-N"), resolve the referenced entity,
 * and remove the dependency. Throws ValidationError for invalid formats.
 *
 * Returns the `Mutated<void>` brand produced by the underlying dependency
 * write so the compile-time guarantee survives this orchestrator (spec-156 ac-20).
 */
export async function removeBlocker(
  memexId: string,
  taskId: string,
  blockedBy: string
): Promise<Mutated<void>> {
  const item = await getTask(memexId, taskId);

  if (parseHandle(blockedBy, "D-") !== null) {
    const dec = await getDecision(memexId, blockedBy, item.docId);
    return removeDecisionDep(memexId, taskId, dec.id);
  } else if (parseHandle(blockedBy, "T-") !== null) {
    const depItem = await getTask(memexId, blockedBy, item.docId);
    return removeTaskDep(memexId, taskId, depItem.id);
  } else {
    throw new ValidationError(
      `Invalid blocker format: "${blockedBy}". Use "D-N" for a decision or "T-N" for a task.`
    );
  }
}
