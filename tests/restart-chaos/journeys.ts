/**
 * Human-in-the-loop journey workloads (Q1, Q2, Q3): a person answers or approves
 * what an agent saved, through the same board routes the UI uses, with a restart
 * fault at the journey's own boundaries (`asked`, `answered`).
 *
 * Q1  questions-and-approvals/questions + continuation: the agent saves a question
 *     and ends its turn; the board answers; the agent finishes with the answer.
 * Q2  the same, but the board adds an unfinished prerequisite before answering.
 *     The answer must reach the agent in bounded answer mode while the task stays
 *     blocked (#20363), then the board finishes the prerequisite and the agent
 *     finishes the task.
 * Q3  questions-and-approvals/tool-review: a connected OAuth app action waits for
 *     review. Before the board decides, more than an hour passes and the access
 *     token is refreshed (#20340). The reviewed action must still run exactly once.
 *
 * This module holds only definitions and pure oracles; journey-driver.ts acts as
 * the board, journey-oauth-app.ts is the harness-owned OAuth/MCP app and
 * journey-matrix.ts crosses every journey with every fault kind.
 */
import type { OracleArtifacts, OracleResult, TriggerId, WorkloadId } from "./types.js";
import type { WorkloadAgents, WorkloadDefinition } from "./workloads.js";

export const JOURNEY_WORKLOADS = ["Q1", "Q2", "Q3"] as const;
export type JourneyWorkload = (typeof JOURNEY_WORKLOADS)[number];
export const isJourneyWorkload = (workload: string): workload is JourneyWorkload =>
  (JOURNEY_WORKLOADS as readonly string[]).includes(workload);

/** `asked`: the request (question or tool review) is saved. `answered`: the board's response was posted. */
export const JOURNEY_TRIGGERS = ["asked", "answered"] as const satisfies readonly TriggerId[];
export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

/** Each workload's own fault boundaries, for the journey × fault matrix. */
export const WORKLOAD_TRIGGERS: Record<WorkloadId, readonly TriggerId[]> = {
  A1: ["time"], B1: ["time"], B5: ["tool"], C1: ["comment", "result"], M1: ["time"], G1: ["approval"],
  H1: ["paused"], R1: ["time"], S1: ["stop"], Q1: JOURNEY_TRIGGERS, Q2: JOURNEY_TRIGGERS, Q3: JOURNEY_TRIGGERS,
};

/** Q3 reviews must survive a delay longer than the implicit deadline #20340 removed. */
export const Q3_REVIEW_AGE_MS = 61 * 60_000;
/** Q2: how long the board waits (server ready) for the answer turn before it finishes the prerequisite anyway. */
export const ANSWER_TURN_WAIT_MS = 6 * 60_000;

export const QUESTION_ID = "codeword";
export const CODE_WORDS = ["amber", "cobalt"] as const;
/** The board's answer, fixed by the nonce so the agent cannot guess it. */
export function journeyChoice(nonce: string): (typeof CODE_WORDS)[number] {
  return CODE_WORDS[Number.parseInt(nonce.slice(1, 2), 16) % 2]!;
}
export const answerMarker = (nonce: string, choice = journeyChoice(nonce)) => `ANSWER-${nonce}-${choice}`;
export const questionTitle = (nonce: string) => `Code word for ${nonce}`;
export const q3ToolArgument = (nonce: string) => `Q3-${nonce}`;
const briefMarker = (nonce: string) => `CHAOS-${nonce}`;

/** What the board did and saw during a journey. Persisted on the task record. */
export interface JourneyRecord {
  /** The trigger the task's own fault waits for (absent: time-fired or no fault). */
  faultTrigger?: TriggerId | null;
  /** The saved question (Q1, Q2) or tool review (Q3), first seen pending. */
  requestSeenAt?: number | null;
  requestId?: string | null;
  /** Q2: the prerequisite the board added before answering. */
  blocker?: { issueId: string | null; at: number; error: string | null };
  /** The board's answer (Q1, Q2) or approval (Q3). `doneAt` arms the `answered` trigger. */
  answer?: { at: number; doneAt: number; httpStatus: number | null; error: string | null; status: string | null;
    pendingWhenAnswered: boolean; faultsBefore: number };
  /** Q2: the agent's reply to the answer while the prerequisite was unfinished. */
  answerTurn?: { at: number; issueStatus: string | null; blockerKept: boolean } | { missedAt: number };
  /** Q2: the board finished the prerequisite. */
  blockerResolved?: { at: number; error: string | null };
  /** Q3: the harness-owned OAuth app, its connection and the scripted agent that uses it. */
  app?: { connectionId: string | null; agentId: string | null; receipt: string; setupError: string | null };
  /** Q3: persisted review and token timestamps moved back, as if the review waited this long. */
  timeShift?: { at: number; ms: number; requests: number; grants: number; error: string | null };
  /** Q3: the board's connection check, which renews the expiring access token. */
  refresh?: { at: number; httpStatus: number | null; error: string | null };
}

export interface JourneyArtifacts {
  record: JourneyRecord;
  /** Q1, Q2: every question card on the task. */
  questions: Array<{ id: string; status: string; createdAt: string | null }>;
  /** Agent comments, oldest first. */
  agentComments: Array<{ createdAt: number; body: string }>;
  /** Every run's error code (cancelled and failed runs included). */
  runErrorCodes: string[];
  /** The task's interruption notice at rest. */
  interruption: { state: string | null; canRetry: boolean } | null;
  /** Q3: every action request on the task and what the provider saw. */
  actionRequests?: Array<{ id: string; status: string }>;
  provider?: { toolCalls: Array<{ at: number; title: unknown }>; refreshes: number[] };
}

function result(checks: OracleResult["checks"]): OracleResult {
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

function briefChecks(body: string | null | undefined, markers: string[]): OracleResult["checks"] {
  const text = body ?? "";
  const bullets = text.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  return [
    { name: "brief_document_present", ok: text.trim().length > 0 },
    ...markers.map(marker => ({ name: `brief_contains_${marker.split("-")[0]!.toLowerCase()}_marker`, ok: text.includes(marker), detail: marker })),
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
}

/** Checks every journey shares: the board's response landed after the planned fault, and no stale Retry is left. */
function responseChecks(journey: JourneyArtifacts, label: string): OracleResult["checks"] {
  const answer = journey.record.answer;
  return [
    { name: `board_${label}`, ok: answer !== undefined && answer.error === null,
      detail: answer ? `status=${answer.httpStatus} ${answer.error ?? answer.status ?? ""}`.trim() : "board never acted" },
    { name: "request_pending_until_response", ok: answer?.pendingWhenAnswered === true },
    // An `asked` fault must have hit the saved request before the board answered it.
    ...(journey.record.faultTrigger === "asked"
      ? [{ name: "response_after_restart", ok: (answer?.faultsBefore ?? 0) > 0, detail: `faults_before=${answer?.faultsBefore ?? 0}` }] : []),
    { name: "no_stale_retry_notice", ok: !journey.interruption?.canRetry,
      detail: journey.interruption ? `state=${journey.interruption.state} canRetry=${journey.interruption.canRetry}` : "none" },
  ];
}

export function gradeQuestionJourney(workload: "Q1" | "Q2", nonce: string, artifacts: OracleArtifacts): OracleResult {
  const journey = artifacts.journey;
  if (!journey) return result([{ name: "journey_recorded", ok: false }]);
  const marker = answerMarker(nonce);
  const checks: OracleResult["checks"] = [
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    // A restart that made the agent ask again is a finding: the saved question is the durable wait.
    { name: "one_question_saved", ok: journey.questions.length === 1, detail: journey.questions.map(question => question.status).join(",") || "none" },
    ...responseChecks(journey, "answered"),
    ...briefChecks(artifacts.documents.brief, [briefMarker(nonce), marker]),
  ];
  if (workload === "Q2") {
    const record = journey.record;
    const turn = record.answerTurn;
    const reached = turn !== undefined && "at" in turn;
    checks.push(
      { name: "prerequisite_added", ok: record.blocker !== undefined && record.blocker.error === null, detail: record.blocker?.error ?? undefined },
      { name: "answer_reached_agent_while_blocked", ok: reached && turn.issueStatus === "blocked",
        detail: !turn ? "board never waited for it" : reached ? `status=${turn.issueStatus}` : "no answer turn within the wait" },
      { name: "prerequisite_kept_through_answer", ok: reached && turn.blockerKept },
      { name: "answer_turn_before_prerequisite_finished", ok: reached && record.blockerResolved !== undefined && turn.at <= record.blockerResolved.at },
      { name: "no_dependency_blocked_failure", ok: !journey.runErrorCodes.includes("issue_dependencies_blocked"),
        detail: journey.runErrorCodes.join(",") || "none" },
    );
  }
  return result(checks);
}

export function gradeToolReviewJourney(nonce: string, artifacts: OracleArtifacts): OracleResult {
  const journey = artifacts.journey;
  if (!journey) return result([{ name: "journey_recorded", ok: false }]);
  const record = journey.record;
  const requests = journey.actionRequests ?? [];
  const calls = journey.provider?.toolCalls ?? [];
  const seen = record.requestSeenAt ?? null;
  const decided = record.answer?.at ?? null;
  const refreshes = (journey.provider?.refreshes ?? []).filter(at => seen !== null && decided !== null && at > seen && at < decided);
  const receipt = record.app?.receipt ?? "";
  return result([
    { name: "oauth_app_connected", ok: Boolean(record.app?.connectionId) && !record.app?.setupError, detail: record.app?.setupError ?? undefined },
    { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` },
    { name: "one_review_requested", ok: requests.length === 1, detail: requests.map(request => request.status).join(",") || "none" },
    { name: "review_aged_past_one_hour", ok: record.timeShift !== undefined && record.timeShift.error === null
      && record.timeShift.ms > 60 * 60_000 && record.timeShift.requests === 1, detail: JSON.stringify(record.timeShift ?? null) },
    { name: "token_refreshed_before_decision", ok: refreshes.length > 0,
      detail: `refreshes_between=${refreshes.length} check=${record.refresh?.httpStatus ?? "none"}` },
    ...responseChecks(journey, "approved"),
    { name: "reviewed_action_ran_once", ok: calls.length === 1 && calls[0]!.title === q3ToolArgument(nonce),
      detail: `calls=${calls.length}${calls.length ? ` title=${JSON.stringify(calls[0]!.title)}` : ""}` },
    { name: "action_executed", ok: requests.length === 1 && requests[0]!.status === "executed" },
    // Only the provider's response carries the receipt: the agent saw the real result.
    { name: "agent_reported_result", ok: receipt.length > 0 && journey.agentComments.some(comment => comment.body.includes(receipt)) },
  ]);
}

const questionBody = (nonce: string) => JSON.stringify({
  kind: "ask_user_questions",
  idempotencyKey: `journey:${nonce}:codeword`,
  title: questionTitle(nonce),
  resolverPolicy: "human_only",
  continuationPolicy: "wake_assignee",
  payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", questions: [{
    id: QUESTION_ID, prompt: "Which code word should the brief use?", answerMode: "single_select", required: true,
    options: CODE_WORDS.map(word => ({ id: word, label: word[0]!.toUpperCase() + word.slice(1) })),
  }] } },
});

const askSteps = (nonce: string) => [
  "Before writing anything, you need one answer from the board.",
  "1. Save exactly one question card with the `call_api` tool: operationId `POST /api/issues/{issueId}/interactions`,",
  `   pathParams \`{ "issueId": "<this task's id>" }\`, and this body: \`${questionBody(nonce)}\``,
  "2. Then set this task's status to `in_review` and end your turn. Do not write the brief yet and do not ask again.",
];

const briefSteps = (nonce: string) => [
  "Save this issue's document with key `brief` (title \"Brief\"), in markdown, on why idempotent retries matter for background job queues.",
  `It must contain the line \`${briefMarker(nonce)}\` exactly, on its own line, and the line \`ANSWER-${nonce}-<code word>\` on its own line,`,
  "where <code word> is the option id the board chose (lowercase), and at least three bullet points that start with \"- \".",
  "Then mark this task done. Do not create files or other tasks.",
];

function q1Description(nonce: string) {
  return [...askSteps(nonce), "3. When you are woken with the board's answer:", ...briefSteps(nonce).map(line => `   ${line}`)].join("\n");
}

function q2Description(nonce: string) {
  return [
    ...askSteps(nonce),
    "3. The board may add a prerequisite task that blocks this one. If you are woken with the answer while this task is still blocked:",
    `   post exactly one comment containing the line \`ANSWER-${nonce}-<code word>\` and end your turn.`,
    "   Do not change this task's status or its blockers, and do not work on the prerequisite.",
    "4. When you are woken after the prerequisite is done (no unfinished blockers remain):",
    ...briefSteps(nonce).map(line => `   ${line}`),
  ].join("\n");
}

const collectBrief = { documents: ["brief"], files: () => [], commands: [] };

export const journeyWorkloadDefinitions: Record<JourneyWorkload, WorkloadDefinition> = {
  Q1: {
    id: "Q1",
    label: "Agent asks the board a question; the answer continues the task",
    usesRepository: false,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos Q1 question ${nonce}`,
    description: (nonce: string, _agents?: WorkloadAgents) => q1Description(nonce),
    collect: collectBrief,
    grade: (nonce, artifacts) => gradeQuestionJourney("Q1", nonce, artifacts),
  },
  Q2: {
    id: "Q2",
    label: "Board answers a question on a dependency-blocked task",
    usesRepository: false,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 25 * 60_000,
    title: nonce => `Chaos Q2 blocked question ${nonce}`,
    description: (nonce: string, _agents?: WorkloadAgents) => q2Description(nonce),
    collect: collectBrief,
    grade: (nonce, artifacts) => gradeQuestionJourney("Q2", nonce, artifacts),
  },
  Q3: {
    id: "Q3",
    label: "Connected-app action approved after token refresh and a long delay",
    usesRepository: false,
    fireWindowMs: [10_000, 40_000],
    budgetMs: 12 * 60_000,
    title: nonce => `Chaos Q3 app review ${nonce}`,
    // A scripted process agent does the work (journey-driver.ts); the description is for people.
    description: nonce => `Create the page \`${q3ToolArgument(nonce)}\` with the connected chaos app, wait for the board's review, then report the result.`,
    collect: { documents: [], files: () => [], commands: [] },
    grade: (nonce, artifacts) => gradeToolReviewJourney(nonce, artifacts),
  },
};
