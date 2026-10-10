import { parseUserQuestionRequest, validateUserQuestionAnswers, type UserQuestionRequest } from "../../../shared/protocol/user_questions.js";

/** SDK question text is an answer key. Shared request IDs are stable array positions. */
export function claudeQuestions(input: Record<string, unknown>, threadId: string, turnId: string, itemId: string): UserQuestionRequest {
  if (!Array.isArray(input.questions)) throw new Error("Invalid Claude questions.");
  const texts = new Set<string>();
  const questions = input.questions.map((value, index) => {
    const q = value as Record<string, unknown> | null;
    if (!q || typeof q.question !== "string" || texts.has(q.question) || (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")) throw new Error("Invalid Claude question.");
    texts.add(q.question);
    return { id: `question-${index}`, header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect ?? false, isOther: true, isSecret: false };
  });
  return parseUserQuestionRequest({ threadId, turnId, itemId, questions, isBlocking: true });
}

export function claudeQuestionAnswers(request: UserQuestionRequest, value: unknown): Record<string, string | string[]> {
  validateUserQuestionAnswers(request.questions, value);
  return Object.fromEntries(request.questions.map(q => [q.question, q.multiSelect ? value[q.id]!.answers : value[q.id]!.answers[0]!]));
}
