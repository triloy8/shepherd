// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async (page) => {
  const stored = page.getByRole('button', { name: 'A new home for Shepherd', exact: true });
  const online = page.getByRole('status', { name: 'Connected', exact: true });
  let payload;
  page.on('request', request => {
    if (request.url().endsWith('/conversations') && request.method() === 'POST') payload = request.postDataJSON();
  });
  await page.route('**/api/v1/conversations', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { error: { code: 'workspace_unavailable', message: 'The conversation’s saved workspace is missing or unavailable. Restore its original directory before resuming.' } } })
    : route.continue());
  await stored.click();
  await page.getByRole('alert').filter({ hasText: 'saved workspace is missing' }).waitFor();
  if (payload.threadId !== 'stored' || 'project' in payload) throw Error('Resume submitted a project override');
  if (await page.getByRole('dialog').count() && await page.getByRole('dialog').first().isVisible()) throw Error('Resume opened a project dialog');
  await page.unroute('**/api/v1/conversations');
  await stored.click();
  await online.waitFor();
  await page.getByText('Where did we leave off?', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  await composer.fill('Keep this draft on resume');
  await page.evaluate(async () => {
    const selected = JSON.parse(localStorage.getItem('shepherd.selection'));
    if (selected.project !== '/saved/workspace') throw Error('Restored workspace not displayed');
    await fetch(`/api/v1/conversations/${selected.id}`, { method: 'DELETE' });
  });
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click({ timeout: 20000 });
  await online.waitFor();
  if (await composer.inputValue() !== 'Keep this draft on resume') throw Error('Draft lost on recovery');
  if ('project' in payload) throw Error('Recovery submitted a project override');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Project', { exact: true }).fill('~/new-project');
  await page.getByRole('button', { name: 'Create conversation', exact: true }).click();
  await online.waitFor();
  if (payload.project !== '~/new-project' || 'threadId' in payload) throw Error('New conversation project selection changed');
  return 'Direct resume, missing-workspace error/retry, expired-handle recovery, draft retention and new-conversation project selection passed';
}
