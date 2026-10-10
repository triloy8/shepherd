import { useId, useState } from "react";
import type { ApprovalRecord } from "../../../shared/protocol/approvals";
import type { UserQuestionAnswers } from "../../../shared/protocol/user_questions";
import { Icon } from "./Icon";

export type DecideQuestion = (id: string, decision: string, answers?: UserQuestionAnswers) => void | Promise<boolean>;

export function UserQuestions({ request, busy, decide }: { request: ApprovalRecord; busy: boolean; decide: DecideQuestion }) {
  const prefix = useId();
  const input = request.userInput!;
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [multiple, setMultiple] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const valueFor = (values: Record<string, string>, id: string) => Object.hasOwn(values, id) ? values[id] ?? "" : "";
  const multipleFor = (values: Record<string, string[]>, id: string) => Object.hasOwn(values, id) ? values[id] ?? [] : [];
  const answerFor = (id: string) => valueFor(selected, id) === "other" || !valueFor(selected, id) ? valueFor(custom, id) : valueFor(selected, id).slice(7);
  const answersFor = (q: typeof input.questions[number]) => q.multiSelect ? [...(multipleFor(multiple, q.id)), ...(valueFor(selected, q.id) === "other" && valueFor(custom, q.id).trim() ? [valueFor(custom, q.id)] : [])] : [answerFor(q.id)];
  const complete = input.questions.every(q => answersFor(q).length > 0 && answersFor(q).every(value => value.trim()));
  return <form className="approval-card" aria-label="Questions from Shepherd" onSubmit={event => {
    event.preventDefault();
    if (busy || !complete) return;
    const answers = Object.fromEntries(input.questions.map(q => [q.id, { answers: answersFor(q) }]));
    void decide(request.approvalId, "submit", answers);
  }}>
    <div className="flex items-center gap-2 text-sm font-medium text-accent"><Icon name="chat" />{input.isBlocking ? "Waiting for your answer" : "Shepherd has a question"}</div>
    <p className="mt-2 text-xs leading-5 text-muted">{input.isBlocking ? "Choose an answer or write your own. Shepherd will continue after you submit." : "You can answer while Shepherd continues working."}</p>
    <div className="mt-5 space-y-6">{input.questions.map((q, index) => {
      const checked = (label: string) => q.multiSelect ? (multipleFor(multiple, q.id)).includes(label) : valueFor(selected, q.id) === `option:${label}`;
      const name = `${prefix}-${index}`;
      const hasOptions = !!q.options?.length && !q.isSecret;
      const showCustom = !hasOptions || valueFor(selected, q.id) === "other";
      return <fieldset key={q.id} disabled={busy}>
        <legend className="text-sm font-medium leading-6">{q.question}</legend>{q.multiSelect && <p className="text-xs text-muted">Choose one or more answers.</p>}
        <div className="mt-3 space-y-2">
          {hasOptions && q.options!.map((option, optionIndex) => <label key={optionIndex} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${checked(option.label) ? "border-accent bg-accent/10" : "border-line hover:bg-panel"}`}>
            <input className="mt-1 accent-accent" type={q.multiSelect ? "checkbox" : "radio"} name={name} value={option.label} checked={checked(option.label)} onChange={() => q.multiSelect ? setMultiple(current => ({ ...current, [q.id]: checked(option.label) ? (multipleFor(current, q.id)).filter(label => label !== option.label) : [...(multipleFor(current, q.id)), option.label] })) : setSelected(current => ({ ...current, [q.id]: `option:${option.label}` }))} />
            <span className="min-w-0"><span className="block text-sm">{option.label}</span>{option.description && <span className="mt-1 block text-xs leading-5 text-muted">{option.description}</span>}</span>
          </label>)}
          {hasOptions && q.isOther && <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${valueFor(selected, q.id) === "other" ? "border-accent bg-accent/10" : "border-line hover:bg-panel"}`}>
            <input className="accent-accent" type={q.multiSelect ? "checkbox" : "radio"} name={name} checked={valueFor(selected, q.id) === "other"} onChange={() => setSelected(current => ({ ...current, [q.id]: q.multiSelect && valueFor(current, q.id) === "other" ? "" : "other" }))} /><span className="text-sm">Write another answer</span>
          </label>}
          {showCustom && <div>
            <label className="mb-2 block text-xs text-muted" htmlFor={`${name}-text`}>{q.isSecret ? "Private answer" : "Your answer"}</label>
            {q.isSecret ? <input id={`${name}-text`} className="w-full rounded-xl border border-line bg-canvas p-3 text-sm" type="password" autoComplete="off" maxLength={16000} value={valueFor(custom, q.id)} onChange={event => setCustom(current => ({ ...current, [q.id]: event.target.value }))} />
              : <textarea id={`${name}-text`} className="w-full resize-y rounded-xl border border-line bg-canvas p-3 text-sm" rows={2} maxLength={16000} value={valueFor(custom, q.id)} onChange={event => setCustom(current => ({ ...current, [q.id]: event.target.value }))} />}
          </div>}
        </div>
      </fieldset>;
    })}</div>
    <div className="mt-5 flex flex-wrap gap-2">
      <button type="submit" className="button-primary" disabled={busy || !complete}>Submit answers</button>
      <button type="button" className="button-secondary" disabled={busy} onClick={() => { void decide(request.approvalId, "cancel"); }}>Skip questions</button>
    </div>
  </form>;
}
