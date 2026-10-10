import { UserQuestions, type DecideQuestion } from "./UserQuestions";
import type { ApprovalRecord } from "../../../shared/protocol/approvals";
import { Icon } from "./Icon";
export function Approvals({ approvals, busy, decide }: { approvals: ApprovalRecord[]; busy: boolean; decide: DecideQuestion }) {
  if (!approvals.length) return null;
  return <section aria-label="Pending requests" className="space-y-3">
    {approvals.map((approval) => approval.userInput ? <UserQuestions key={approval.approvalId} request={approval} busy={busy} decide={decide} /> : <div className="approval-card" key={approval.approvalId}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-accent"><Icon name="shield" />Your approval is needed</div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{approval.prompt}</p>
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Request details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3">{approval.detail ?? approval.prompt}</pre></details>
      <div className="mt-4 flex flex-wrap gap-2">{approval.choices.map((choice) => <button key={choice.value} className="button-secondary" disabled={busy} onClick={() => decide(approval.approvalId, choice.value)}>{choice.label}</button>)}</div>
    </div>)}
  </section>;
}
