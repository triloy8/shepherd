/** Provider-neutral interactive questions. Missing multiSelect means a single answer. */
export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}
export interface UserQuestionRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserQuestion[];
  isBlocking: boolean;
}
export type UserQuestionAnswers = Record<string, { answers: string[] }>;

export function parseUserQuestionRequest(value: unknown): UserQuestionRequest {
  const p = value as Partial<UserQuestionRequest> | null;
  if (!p || ![p.threadId, p.turnId, p.itemId].every(v => typeof v === "string" && v.length > 0) || !Array.isArray(p.questions) || !p.questions.length ||
      (p.isBlocking !== undefined && typeof p.isBlocking !== "boolean")) throw new Error("Invalid user question request.");
  const ids = new Set<string>();
  for (const q of p.questions) {
    if (!q || ![q.id, q.header, q.question].every(v => typeof v === "string" && v.length > 0) || ids.has(q.id) ||
        (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") || typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean" ||
        (q.options !== null && (!Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== "string" || !o.label.trim() || typeof o.description !== "string")))) {
      throw new Error("Invalid user question.");
    }
    ids.add(q.id);
  }
  return { threadId: p.threadId!, turnId: p.turnId!, itemId: p.itemId!, questions: p.questions, isBlocking: p.isBlocking ?? true };
}

/** Validate before changing pending state, so invalid submissions can be retried. */
export function validateUserQuestionAnswers(questions: UserQuestion[], value: unknown): asserts value is UserQuestionAnswers {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Answer every question before submitting.");
  const answers = value as UserQuestionAnswers;
  if (Object.keys(answers).length !== questions.length || Object.keys(answers).some(id => !questions.some(q => q.id === id))) throw new Error("Answer every question before submitting.");
  for (const q of questions) {
    const answer = Object.hasOwn(answers, q.id) ? answers[q.id] : null;
    if (!answer || !Array.isArray(answer.answers) || !answer.answers.length ||
        (!q.multiSelect && answer.answers.length !== 1) || answer.answers.length > 100 ||
        new Set(answer.answers).size !== answer.answers.length ||
        answer.answers.some(v => typeof v !== "string" || !v.trim() || v.length > 16_000)) {
      throw new Error("Each question needs valid, nonempty answers of at most 16000 characters.");
    }
    if (q.options?.length && !q.isOther && answer.answers.some(v => !q.options!.some(o => o.label === v))) throw new Error("Choose one of the offered answers.");
  }
}
