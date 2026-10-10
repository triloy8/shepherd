// Run against the isolated fixture using playwright-cli run-code in Firefox.
async (page) => {
  const errors = [], creates = [], answers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/conversations')) creates.push(request.postDataJSON());
    if (request.url().includes('/approvals/')) answers.push(request.postDataJSON());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = async () => {
    if (!(await page.getByRole('button', { name: 'New conversation', exact: true }).isVisible())) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  };
  await sidebar();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const project = page.locator('dialog[open]');
  await project.getByLabel('Agent', { exact: true }).selectOption('claude');
  await project.getByLabel('Project', { exact: true }).fill('~');
  await project.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  if (creates.at(-1)?.provider !== 'claude') throw Error('Selected provider was not sent');
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('provider question multi select');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const form = page.getByRole('form', { name: 'Questions from Shepherd' });
  await form.getByRole('checkbox').nth(0).check();
  await form.getByRole('checkbox').nth(1).check();
  await form.getByRole('button', { name: 'Submit answers', exact: true }).click();
  await page.getByText('Thanks. I’ll use your answer:', { exact: false }).waitFor();
  if (answers.at(-1)?.answers.provider.answers.length !== 2) throw Error('Multiple answers were not preserved');
  if (['submit', 'accept'].includes(answers.at(-1)?.decision)) throw Error('Native decision leaked into the form');
  await page.screenshot({ path: '.playwright-cli/provider-interface-mobile-chat.png', fullPage: true });
  await sidebar();
  await page.getByRole('button', { name: 'Usage & limits', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Usage & limits' });
  await usage.getByText('37% used', { exact: true }).waitFor();
  if (await usage.getByRole('combobox').inputValue() !== 'claude') throw Error('Usage did not open on conversation provider');
  if (await usage.getByRole('region', { name: 'Banked resets' }).count()) throw Error('Unsupported reset controls shown');
  await page.screenshot({ path: '.playwright-cli/provider-interface-mobile-usage.png', fullPage: true });
  await usage.getByRole('combobox').selectOption('codex');
  await usage.getByText('25% used', { exact: true }).waitFor();
  await usage.getByRole('button', { name: 'Use available reset', exact: true }).waitFor();
  await usage.getByRole('combobox').selectOption('claude');
  await usage.getByText('37% used', { exact: true }).waitFor();
  await usage.getByRole('button', { name: 'Close usage & limits', exact: true }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow');
  if (errors.length) throw Error(errors.join('\n'));
}
