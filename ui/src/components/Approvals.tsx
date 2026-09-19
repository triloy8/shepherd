import type { ApprovalRecord } from "../../../shared/protocol/approvals";
import { Icon } from "./Icon";
export function Approvals({ approvals, busy, decide }: { approvals: ApprovalRecord[]; busy: boolean; decide: (id: string, decision: string) => void }) {
  if (!approvals.length) return null;
  return <section aria-label="Pending approvals" className="space-y-3">
    {approvals.map((approval) => <div className="approval-card" key={approval.approvalId}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-accent"><Icon name="shield" />Your approval is needed</div>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{approval.prompt}</p>
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Request details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3">{JSON.stringify(approval.params, null, 2)}</pre></details>
      <div className="mt-4 flex flex-wrap gap-2">{approval.choices.map((choice) => <button key={choice.value} className="button-secondary" disabled={busy} onClick={() => decide(approval.approvalId, choice.value)}>{choice.label}</button>)}</div>
    </div>)}
  </section>;
}
