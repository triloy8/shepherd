import type { ConversationItem } from "../../../shared/protocol/v2/conversation_items";
import { UserQuestions, type DecideQuestion } from "./UserQuestions";
import type { InteractionRecord, PermissionDetails } from "../../../shared/protocol/v2/interactions";
import { Icon } from "./Icon";

function Permissions({ details }: { details: PermissionDetails | null }) {
  if (!details) return null;
  return <div className="space-y-1 text-xs text-muted">
    {details.cwd && <p>Working directory: {details.cwd}</p>}
    {details.filesystem.map((rule, index) => <p key={`file:${index}`}>{rule.access === "write" ? "Write" : "Read"}: {rule.path}</p>)}
    {details.network.map((rule, index) => <p key={`network:${index}`}>{rule.access === "allow" ? "Allow" : "Deny"} network: {rule.host ?? "Any host"}</p>)}
    {details.commands.map((rule, index) => <p key={`command:${index}`}>{rule.scope}: {rule.match.text}{rule.match.truncated ? " (preview shortened)" : ""}</p>)}
    {details.explanation && <p>{details.explanation.text}{details.explanation.truncated ? " (preview shortened)" : ""}</p>}
  </div>;
}
export function Approvals({ approvals, items = [], busy, decide }: { approvals: InteractionRecord[]; items?: ConversationItem[]; busy: boolean; decide: DecideQuestion }) {
  if (!approvals.length) return null;
  return <section aria-label="Pending requests" className="space-y-3">{approvals.map(request => { const item = request.item ?? items.find(item => item.id === request.itemId); return request.questions
    ? <UserQuestions key={request.id} request={request} busy={busy} decide={decide} />
    : <div className="approval-card" key={request.id}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-accent"><Icon name="shield" />{request.title}</div>
      {request.reason && <p className="whitespace-pre-wrap break-words text-sm leading-6">{request.reason.text}</p>}
      {item?.type === "tool" && item.input && <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs">{item.input.text}</pre>}
      {item?.type === "tool" && item.input?.truncated && <p className="text-xs text-muted">Request preview shortened; some details are unavailable.</p>}
      {item?.type === "command" && <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{item.command.text}</pre>}
      {item?.type === "file_change" && item.changes.map((change, index) => <div key={index} className="mt-3 text-xs"><p>{change.kind}: {change.path}{change.movePath ? ` → ${change.movePath}` : ""}</p>{change.diff && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{change.diff.text}</pre>}{change.diff?.truncated && <p className="text-muted">Diff preview shortened.</p>}</div>)}
      {!item && request.itemId && <p className="text-xs text-muted">Item details are unavailable. Refresh history to recover them.</p>}
      <Permissions details={request.permissions} />
      <div className="mt-4 flex flex-wrap gap-3">{request.options.map(option => <div key={option.id}>
        {option.effect && <Permissions details={option.effect} />}
        <button className="button-secondary" disabled={busy} onClick={() => decide(request.id, option.id)}>{option.label}{option.scope === "persistent" ? " (changes future permissions)" : ""}</button>
      </div>)}</div>
    </div>; })}</section>;
}
