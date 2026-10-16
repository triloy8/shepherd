// Independent question shapes at the application HTTP boundary; run in Firefox.
async page => {
  page.setDefaultTimeout(10000);
  const errors = [], submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  let id = 'constructor', answered = false;
  const record = () => ({ approvalId: `question-${id}`, kind: 'question', prompt: 'Choose', detail: null,
    choices: [{ value: 'submit-native', label: 'Answer', intent: 'answer' }],
    userInput: { threadId: 'stored', turnId: 'question-turn', itemId: 'q', isBlocking: true,
      questions: [{ id, header: 'Choose', question: `Choose for ${id}`, multiSelect: true, isOther: false,
        options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] },
    threadId: 'stored', sessionId: 'fixture', status: 'pending', createdAt: 'now', updatedAt: 'now' });
  await page.route('**/api/conversations/*/approvals', route => route.fulfill({ json: { approvals: answered ? [] : [record()] } }));
  await page.route('**/api/conversations/*/approvals/*', route => {
    submissions.push(route.request().postDataJSON()); answered = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  for (const value of ['constructor', 'toString', '__proto__']) {
    id = value; answered = false;
    if (value === '__proto__') await page.setViewportSize({ width: 390, height: 844 });
    if (value !== 'constructor') await page.reload();
    const form = page.getByRole('form', { name: 'Questions from Shepherd', exact: true });
    await form.getByText(`Choose for ${id}`, { exact: true }).waitFor();
    if (await form.getByRole('button', { name: 'Skip questions', exact: true }).count()) throw Error('Mandatory question exposed an unsupported cancellation');
    const submit = form.getByRole('button', { name: 'Submit answers', exact: true });
    if (await submit.isEnabled()) throw Error('Unanswered multiselect was submittable');
    await form.getByRole('checkbox', { name: 'A', exact: true }).check();
    await form.getByRole('checkbox', { name: 'B', exact: true }).check();
    await form.getByRole('checkbox', { name: 'A', exact: true }).uncheck();
    await submit.click();
    await form.waitFor({ state: 'hidden' });
    const payload = submissions.at(-1);
    if (payload.decision !== 'submit-native' || !Object.hasOwn(payload.answers, id) || JSON.stringify(payload.answers[id]) !== '["B"]') throw Error('Opaque question identity or selected answer was lost');
  }
  if (errors.length) throw Error(errors.join('\n'));
  return 'Opaque multiselect IDs, check/uncheck, answer-only questions, application decisions and refresh passed';
}
