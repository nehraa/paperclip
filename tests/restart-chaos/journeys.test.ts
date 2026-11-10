import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { JourneyDriver, questionAnswer, type JourneyHost } from "./journey-driver.js";
import { matrixCells, planMatrixWave } from "./journey-matrix.js";
import { startOAuthApp } from "./journey-oauth-app.js";
import {
  answerMarker, gradeQuestionJourney, gradeToolReviewJourney, journeyChoice, q3ToolArgument, Q3_REVIEW_AGE_MS,
  type JourneyArtifacts, type JourneyRecord,
} from "./journeys.js";
import { planTasks, taskFaultSchedule } from "./scheduler.js";
import { Timeline } from "./timeline.js";
import type { OracleArtifacts, ScheduledFault, TaskPlan, TaskRecord, TaskSample } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const nonce = "a1b2c3d4";

function artifacts(journey: Partial<JourneyArtifacts> & { record: JourneyRecord }, overrides: Partial<OracleArtifacts> = {}): OracleArtifacts {
  return { issueStatus: "done", documents: { brief: `CHAOS-${nonce}\n${answerMarker(nonce)}\n- one\n- two\n- three\n` }, agentComments: [],
    files: {}, commands: {}, workspacePath: null,
    journey: { questions: [{ id: "q", status: "answered", createdAt: null }], agentComments: [], runErrorCodes: [], interruption: null, ...journey },
    ...overrides };
}

const answered = (extra: Partial<NonNullable<JourneyRecord["answer"]>> = {}) => ({ at: 2_000, doneAt: 2_100, httpStatus: 200, error: null,
  status: "answered", pendingWhenAnswered: true, faultsBefore: 1, ...extra });

const failed = (result: ReturnType<typeof gradeQuestionJourney>) => result.checks.filter(check => !check.ok).map(check => check.name);

describe("journey oracles", () => {
  it("passes Q1 when one saved question is answered after the restart and the brief uses the answer", () => {
    const result = gradeQuestionJourney("Q1", nonce, artifacts({ record: { faultTrigger: "asked", requestSeenAt: 1_000, answer: answered() } }));
    expect(failed(result)).toEqual([]);
  });

  it("fails Q1 when a restart made the agent ask twice, or the answer missed the brief", () => {
    const result = gradeQuestionJourney("Q1", nonce, artifacts({ record: { faultTrigger: "asked", requestSeenAt: 1_000, answer: answered({ faultsBefore: 0 }) },
      questions: [{ id: "a", status: "answered", createdAt: null }, { id: "b", status: "pending", createdAt: null }] },
    { documents: { brief: `CHAOS-${nonce}\n- one\n- two\n- three` } }));
    expect(failed(result)).toEqual(["one_question_saved", "response_after_restart", "brief_contains_answer_marker"]);
  });

  it("fails Q1 on a stale Retry notice left after the answered work finished", () => {
    const result = gradeQuestionJourney("Q1", nonce, artifacts({ record: { requestSeenAt: 1, answer: answered() },
      interruption: { state: "failed", canRetry: true } }));
    expect(failed(result)).toEqual(["no_stale_retry_notice"]);
  });

  it("fails Q2 the way #20363's parent does: the answer never reaches the blocked task", () => {
    const record: JourneyRecord = { requestSeenAt: 1_000, blocker: { issueId: "b", at: 1_500, error: null }, answer: answered(),
      answerTurn: { missedAt: 400_000 }, blockerResolved: { at: 400_100, error: null } };
    expect(failed(gradeQuestionJourney("Q2", nonce, artifacts({ record, runErrorCodes: ["issue_dependencies_blocked"] }))))
      .toEqual(["answer_reached_agent_while_blocked", "prerequisite_kept_through_answer", "answer_turn_before_prerequisite_finished",
        "no_dependency_blocked_failure"]);
  });

  it("passes Q2 when the answer turn ran while the task stayed blocked by its prerequisite", () => {
    const record: JourneyRecord = { requestSeenAt: 1_000, blocker: { issueId: "b", at: 1_500, error: null }, answer: answered(),
      answerTurn: { at: 60_000, issueStatus: "blocked", blockerKept: true }, blockerResolved: { at: 70_000, error: null } };
    expect(failed(gradeQuestionJourney("Q2", nonce, artifacts({ record })))).toEqual([]);
  });

  const q3Record = (extra: Partial<JourneyRecord> = {}): JourneyRecord => ({
    requestSeenAt: 1_000, app: { connectionId: "c", agentId: "a", receipt: "receipt-x", setupError: null },
    timeShift: { at: 1_100, ms: Q3_REVIEW_AGE_MS, requests: 1, grants: 1, error: null },
    refresh: { at: 1_200, httpStatus: 200, error: null }, answer: answered({ status: "executed" }), ...extra });

  it("passes Q3 when an aged review approved after a token refresh runs the reviewed action once", () => {
    const result = gradeToolReviewJourney(nonce, artifacts({ record: q3Record(), actionRequests: [{ id: "r", status: "executed" }],
      provider: { toolCalls: [{ at: 2_050, title: q3ToolArgument(nonce) }], refreshes: [1_250] },
      agentComments: [{ createdAt: 3_000, body: "Q3 result: Created page. receipt-x" }] }, { documents: {} }));
    expect(failed(result)).toEqual([]);
  });

  it("fails Q3 the way #20340's parent does: the refresh invalidates the approval", () => {
    const record = q3Record({ answer: answered({ httpStatus: 409, error: "approved_tool_target_changed", status: null }) });
    const result = gradeToolReviewJourney(nonce, artifacts({ record, actionRequests: [{ id: "r", status: "pending" }],
      provider: { toolCalls: [], refreshes: [1_250] } }, { issueStatus: "in_review", documents: {} }));
    expect(failed(result)).toEqual(["issue_done", "board_approved", "reviewed_action_ran_once", "action_executed", "agent_reported_result"]);
  });

  it("does not credit a refresh that happened only during the approval itself", () => {
    const result = gradeToolReviewJourney(nonce, artifacts({ record: q3Record(), actionRequests: [{ id: "r", status: "executed" }],
      provider: { toolCalls: [{ at: 2_050, title: q3ToolArgument(nonce) }], refreshes: [2_010] },
      agentComments: [{ createdAt: 3_000, body: "receipt-x" }] }, { documents: {} }));
    expect(failed(result)).toEqual(["token_refreshed_before_decision"]);
  });
});

describe("journey planning", () => {
  it("fires journey faults at their own boundaries", () => {
    const tasks = planTasks({ seed: 5, tasks: 4, workloads: ["Q1", "Q2"], adapters: ["codex"], faults: ["K1"], triggers: ["asked", "answered"] });
    expect(new Set(tasks.map(task => task.trigger))).toEqual(new Set(["asked", "answered"]));
    for (const task of tasks) expect(taskFaultSchedule(task)).toEqual([expect.objectContaining({ kind: "K1", trigger: task.trigger })]);
    expect(() => planTasks({ seed: 5, tasks: 1, workloads: ["A1"], adapters: ["codex"], faults: ["K1"], triggers: ["asked"] }))
      .toThrow(/Q1, Q2 or Q3/);
  });

  it("crosses every journey with a baseline and every fault at each of its triggers", () => {
    const cells = matrixCells({ workloads: ["Q1", "Q2", "Q3"], adapters: ["codex"], faults: ["K1", "K2", "K4"] });
    expect(cells).toHaveLength(3 * (1 + 3 * 2));
    expect(cells.filter(cell => cell.workload === "Q3").map(cell => `${cell.fault}^${cell.trigger}`)).toEqual([
      "K0^time", "K1^asked", "K1^answered", "K2^asked", "K2^answered", "K4^asked", "K4^answered"]);
    const command = parseCommand(["--workloads", "Q1,Q2,Q3,G1", "--faults", "K1,K2,K4", "--adapters", "codex", "--matrix", "--seed", "9"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ matrix: true, tasks: 21 + 4 });
    const plan = planMatrixWave("w-20261109T000000-s9", command.options);
    expect(plan.tasks).toHaveLength(25);
    const baseline = plan.tasks.find(task => task.fault === "K0")!;
    expect(taskFaultSchedule(baseline)).toEqual([]);
    expect(plan.tasks.filter(task => task.workload === "G1").map(task => task.trigger ?? "time")).toEqual(["time", "approval", "approval", "approval"]);
    expect(planMatrixWave("w-20261109T000000-s9", command.options).tasks).toEqual(plan.tasks);
  });

  it("validates --matrix and --server-from", () => {
    expect(() => parseCommand(["--workloads", "Q1", "--matrix", "--tasks", "3"])).toThrow(/do not pass --tasks/);
    expect(() => parseCommand(["--workloads", "Q1", "--matrix", "--triggers", "asked"])).toThrow(/own triggers/);
    const command = parseCommand(["--workloads", "Q2", "--server-from", "../old", "--faults", "K1"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.serverFrom).toMatch(/\/old$/);
    expect(() => parseCommand(["--workloads", "Q2", "--server-from", "../old", "--faults", "K14", "--upgrade-from", "../older"])).toThrow(/upgrade-from/);
  });

  it("keeps journeys out of the default workloads and registers their definitions", () => {
    const command = parseCommand(["--adapters", "codex"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options.workloads).not.toContain("Q1");
    expect(workloadDefinitions.Q2.description(nonce)).toContain(`ANSWER-${nonce}-<code word>`);
    expect(journeyChoice(nonce)).toMatch(/^(amber|cobalt)$/);
  });
});

describe("harness OAuth app", () => {
  it("runs a PKCE authorization, rotates tokens on refresh and records tool calls", async () => {
    const app = await startOAuthApp();
    try {
      const unauthenticated = await fetch(app.mcpUrl, { method: "POST", body: "{}" });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      await fetch(`${app.origin}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"] }) });
      const authorize = await fetch(`${app.origin}/authorize?redirect_uri=${encodeURIComponent("http://127.0.0.1:1/cb")}&state=s1`, { redirect: "manual" });
      const back = new URL(authorize.headers.get("location")!);
      expect(back.searchParams.get("state")).toBe("s1");
      const token = async (form: Record<string, string>) => (await fetch(`${app.origin}/token`, { method: "POST", body: new URLSearchParams(form) })).json() as Promise<Record<string, string>>;
      const first = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")! });
      const second = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token! });
      expect(second.access_token).not.toBe(first.access_token);
      expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token! })).error).toBe("invalid_grant");
      const call = await fetch(app.mcpUrl, { method: "POST", headers: { authorization: `Bearer ${second.access_token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_page", arguments: { title: "T" } } }) });
      expect(JSON.stringify(await call.json())).toContain(app.receipt);
      expect(app.record).toMatchObject({ registrations: 1, codeExchanges: 1, rejectedRefreshes: 1, toolCalls: [{ title: "T" }] });
      expect(app.record.refreshes).toHaveLength(1);
    } finally { await app.close(); }
  });
});

describe("journey driver", () => {
  function harness(workload: "Q1" | "Q2", trigger: TaskPlan["trigger"] = "answered") {
    const plan: TaskPlan = { taskId: "t01", index: 0, workload, adapter: "codex", fault: "K1", fireAfterMs: 0, holdMs: 0,
      trigger, triggerDelayMs: 0, followUpAfterMs: null, nonce };
    const record = { plan, issueId: "issue-1", faultIds: [] } as unknown as TaskRecord;
    const calls: string[] = [];
    let interaction = { id: "i1", kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [{ id: "codeword",
      prompt: "Which code word?", options: [{ id: "opt-a", label: "Amber" }, { id: "opt-c", label: "Cobalt" }] }] } };
    const api = {
      baseUrl: "http://x",
      async get(route: string) {
        if (route.endsWith("/interactions")) return [interaction];
        if (route.endsWith("/comments")) return [{ authorAgentId: "agent", body: `ok ${answerMarker(nonce)}`, createdAt: new Date(Date.now() + 60_000).toISOString() }];
        if (route === "/api/issues/issue-1") return { status: "blocked", blockedBy: [{ id: "blocker-1" }] };
        throw new Error(`unexpected GET ${route}`);
      },
      async post(route: string, body: unknown) {
        calls.push(`POST ${route} ${JSON.stringify(body)}`);
        if (route.endsWith("/respond")) { interaction = { ...interaction, status: "answered" }; return interaction; }
        if (route.endsWith("/issues")) return { id: "blocker-1" };
        throw new Error(`unexpected POST ${route}`);
      },
      async patch(route: string, body: unknown) { calls.push(`PATCH ${route} ${JSON.stringify(body)}`); return {}; },
    };
    const host: JourneyHost = { plan, api: api as unknown as JourneyHost["api"], lab: { companyId: "c" } as JourneyHost["lab"],
      timeline: new Timeline(null), record, databaseUrl: () => null };
    return { driver: new JourneyDriver(workload, host), calls, record };
  }
  it("answers with the agent's own question and option ids, matched by the chosen code word", () => {
    const card = { payload: { questionSet: { questions: [{ id: "q-7", options: [{ id: "x", label: " Cobalt " }, { id: "amber", label: "Warm" }] }] } } };
    expect(questionAnswer(card, "cobalt")).toEqual({ questionId: "q-7", optionIds: ["x"] });
    expect(questionAnswer(card, "amber")).toEqual({ questionId: "q-7", optionIds: ["amber"] });
    expect(questionAnswer({ payload: {} }, "amber")).toBeNull();
  });

  const sample = (runs: TaskSample["runs"] = []): TaskSample => ({ at: 0, reachable: true, serverReady: true, runs });
  const answeredFault: ScheduledFault = { kind: "K1", holdMs: 0, atMs: 0, trigger: "answered", delayMs: 0 };

  it("answers only once the planned faults before the answer fired, then arms the answered trigger", async () => {
    const { driver, calls, record } = harness("Q1", "asked");
    const askedFault: ScheduledFault = { kind: "K1", holdMs: 0, atMs: 0, trigger: "asked", delayMs: 0 };
    expect(await driver.step({ sample: sample(), now: 1_000, quiet: true, pendingFaults: [askedFault] })).toBe(false);
    expect(driver.armedAt("asked")).toBe(1_000);
    expect(driver.awaitingBoard()).toBe(true);
    expect(calls).toEqual([]);
    record.faultIds.push("f1");
    expect(await driver.step({ sample: sample(), now: 5_000, quiet: true, pendingFaults: [] })).toBe(true);
    const optionId = journeyChoice(nonce) === "amber" ? "opt-a" : "opt-c";
    expect(calls).toEqual([`POST /api/issues/issue-1/interactions/i1/respond {"answers":[{"questionId":"codeword","optionIds":["${optionId}"]}]}`]);
    expect(driver.armedAt("answered")).toBeGreaterThanOrEqual(5_000);
    expect(record.journey!.answer).toMatchObject({ pendingWhenAnswered: true, faultsBefore: 1, error: null });
    expect(driver.awaitingBoard()).toBe(false);
  });

  it("Q2: adds the prerequisite, answers, waits for the answer turn, then finishes the prerequisite", async () => {
    const { driver, calls, record } = harness("Q2");
    const running = sample([{ id: "r1", status: "running", createdAt: null, startedAt: null, finishedAt: null, errorCode: null,
      retryOfRunId: null, wakeCommentIds: [], livenessState: null }]);
    expect(await driver.step({ sample: running, now: 1_000, quiet: true, pendingFaults: [answeredFault] })).toBe(false);
    expect(await driver.step({ sample: sample(), now: 2_000, quiet: true, pendingFaults: [answeredFault] })).toBe(true);
    expect(calls.at(-1)).toBe('PATCH /api/issues/issue-1 {"status":"blocked","blockedByIssueIds":["blocker-1"]}');
    expect(await driver.step({ sample: sample(), now: 3_000, quiet: true, pendingFaults: [answeredFault] })).toBe(true);
    expect(calls.at(-1)).toContain("/respond");
    // The answered fault is still pending: the turn is observed, the prerequisite stays until the fault fired.
    expect(await driver.step({ sample: sample(), now: 4_000, quiet: true, pendingFaults: [answeredFault] })).toBe(false);
    expect(record.journey!.answerTurn).toMatchObject({ issueStatus: "blocked", blockerKept: true });
    expect(driver.awaitingBoard()).toBe(true);
    expect(await driver.step({ sample: sample(), now: 5_000, quiet: true, pendingFaults: [] })).toBe(true);
    expect(calls.at(-1)).toBe('PATCH /api/issues/blocker-1 {"status":"done"}');
    expect(driver.awaitingBoard()).toBe(false);
  });
});
