import { UserQuestions, type DecideQuestion } from "./UserQuestions";
import type { ApprovalRecord } from "../../../shared/protocol/approvals";
import { Icon } from "./Icon";
import { describePermission } from "../../../shared/protocol/activity";
export function Approvals({ approvals, busy, decide }: { approvals: ApprovalRecord[]; busy: boolean; decide: DecideQuestion }) {
  if (!approvals.length) return null;
  return <section aria-label="Pending requests" className="space-y-3">
    {approvals.map((approval) => approval.kind === "question" ? <UserQuestions key={approval.approvalId} request={approval} busy={busy} decide={decide} /> : <Permission key={approval.approvalId} approval={approval} busy={busy} decide={decide} />)}
  </section>;
}

function Permission({ approval, busy, decide }: { approval: Extract<ApprovalRecord, { kind: "permission" }>; busy: boolean; decide: DecideQuestion }) {
  const { title, detail } = describePermission(approval.activity);
  return <div className="approval-card">
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-accent"><Icon name="shield" />Your approval is needed</div>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{title}</p>
    {approval.reason && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted">{approval.reason}</p>}
    {detail && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Request details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3">{detail}</pre></details>}
    <div className="mt-4 flex flex-wrap gap-2">{approval.choices.map((choice) => <button key={choice.value} className="button-secondary" disabled={busy} onClick={() => decide(approval.approvalId, choice.value)}>{choice.label}</button>)}</div>
  </div>;
}
