/**
 * `--matrix`: one task per cell of workload × adapter × (no fault, or each
 * `--faults` kind at each of the workload's own fault boundaries). A journey
 * workload (Q1–Q3) gets a K0 baseline plus every fault at `asked` and at
 * `answered`; G1 at `approval`, C1 at `comment` and `result`, and so on
 * (journeys.ts WORKLOAD_TRIGGERS). The cells run in a fixed order so a seed
 * always means the same matrix; `--tasks` is the cell count.
 */
import path from "node:path";
import { WORKLOAD_TRIGGERS } from "./journeys.js";
import { createRng, k4HoldRange, TRIGGER_DELAY_RANGE_MS } from "./scheduler.js";
import { workloadDefinitions } from "./workloads.js";
import type { AdapterId, TaskFaultKind, TaskPlan, TriggerId, WaveOptions, WavePlan, WorkloadId } from "./types.js";

export interface MatrixCell { workload: WorkloadId; adapter: AdapterId; fault: TaskFaultKind; trigger: TriggerId }

export function matrixCells(options: Pick<WaveOptions, "workloads" | "adapters" | "faults">): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const workload of options.workloads) for (const adapter of options.adapters) {
    // The baseline: the same journey with no fault, so a fault cell's failure is attributable.
    cells.push({ workload, adapter, fault: "K0", trigger: "time" });
    for (const fault of options.faults) for (const trigger of WORKLOAD_TRIGGERS[workload]) cells.push({ workload, adapter, fault, trigger });
  }
  return cells;
}

export function planMatrixTasks(options: Pick<WaveOptions, "seed" | "workloads" | "adapters" | "faults" | "k4HoldMaxMs">): TaskPlan[] {
  const rng = createRng((options.seed ^ 0x6a6d7478) >>> 0);
  return matrixCells(options).map((cell, index) => {
    const definition = workloadDefinitions[cell.workload];
    const [fireMin, fireMax] = definition.fireWindowMs;
    return {
      taskId: `t${String(index + 1).padStart(2, "0")}`,
      index,
      workload: cell.workload,
      adapter: cell.adapter,
      fault: cell.fault,
      ...(cell.trigger === "time" ? {} : { trigger: cell.trigger, triggerDelayMs: rng.int(...TRIGGER_DELAY_RANGE_MS[cell.trigger]) }),
      fireAfterMs: cell.fault === "K0" ? 0 : rng.int(fireMin, fireMax),
      holdMs: cell.fault === "K4" ? rng.int(...k4HoldRange(options.k4HoldMaxMs)) : 0,
      followUpAfterMs: definition.followUpWindowMs ? rng.int(definition.followUpWindowMs[0], definition.followUpWindowMs[1]) : null,
      nonce: rng.hex(8),
    };
  });
}

/** `--matrix` and `--server-from`, validated against the rest of the parsed options. */
export function applyJourneyOptions(options: WaveOptions, input: { matrix: boolean; serverFrom: string | undefined; tasksGiven: boolean; triggersGiven: boolean }) {
  if (input.matrix) {
    if (options.stormMinutes || options.crashPoint) throw new Error("--matrix plans its own cells; it does not combine with --storm-minutes or --crash-point");
    if (input.tasksGiven) throw new Error("--matrix runs one task per cell; do not pass --tasks");
    if (input.triggersGiven) throw new Error("--matrix uses each workload's own triggers; do not pass --triggers");
    if (options.faults.includes("K14")) throw new Error("--matrix does not cross K14 (an upgrade happens once per wave)");
    options.matrix = true;
    options.tasks = matrixCells(options).length;
  }
  if (input.serverFrom !== undefined) {
    if (options.env !== "local") throw new Error("--server-from runs only with --env local");
    if (options.faults.includes("K14")) throw new Error("--server-from runs every server from one checkout; use --upgrade-from for K14");
    options.serverFrom = path.resolve(input.serverFrom);
  }
}

export function planMatrixWave(waveId: string, options: WaveOptions, createdAt = new Date()): WavePlan {
  const tasks = planMatrixTasks(options);
  return { schema: "paperclip.restart-chaos.wave-plan/v1", waveId, seed: options.seed, createdAt: createdAt.toISOString(),
    options: { ...options, tasks: tasks.length }, tasks };
}
