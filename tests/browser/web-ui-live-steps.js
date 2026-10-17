// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('live steps');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // Reasoning streams into a running step, its summary parts kept apart.
  const reasoning = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: 'Reasoning summary · Running' }) });
  await reasoning.waitFor();
  await reasoning.locator(':scope > summary').click();
  await reasoning.getByText('Reading the failing test.\n\nRunning it again.', { exact: true }).waitFor();
  // A running command shows its output so far.
  const command = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: '· Running' }) }).filter({ hasNot: page.locator(':scope > summary', { hasText: 'Reasoning' }) });
  await command.locator(':scope > summary').click();
  await command.getByLabel('Output so far').getByText('streamed output line', { exact: false }).waitFor();
  // Completion replaces both with their canonical items.
  await page.getByText('Live steps finished.', { exact: true }).waitFor();
  if (await page.getByLabel('Output so far').count()) throw Error('Output remained after the step completed');
  if (await page.getByText('· Running', { exact: false }).count()) throw Error('A step stayed running after completion');
}
