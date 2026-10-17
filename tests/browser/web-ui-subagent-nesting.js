// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('subagent');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Let’s make it happen.', { exact: false }).first().waitFor();
  const work = page.locator('.progress-disclosure').last();
  await work.locator(':scope > summary').click();
  const step = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Delegating to an agent · Done' }) });
  await step.locator(':scope > summary').click();
  const rows = step.getByLabel('Subagent work');
  await rows.getByText('Subagent is looking around.', { exact: true }).waitFor();
  // The subagent's step and its late text land inside the delegation after the turn ended.
  await rows.getByText('Subagent finished late.', { exact: true }).waitFor();
  if (!(await rows.getByText('ls subagent', { exact: false }).count())) throw Error('Subagent step missing from its delegation');
  const answer = page.locator('.assistant-response').last();
  if (await answer.getByText('Subagent', { exact: false }).count()) throw Error('Subagent text became the answer');
}
