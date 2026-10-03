// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('parity');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const work = page.locator('.progress-disclosure').filter({ hasText: '1 failed step' });
  const summary = work.locator(':scope > summary');
  await page.getByText('1 failed step', { exact: false }).waitFor();
  const failure = page.getByText('Running command · Failed', { exact: true });
  if (await failure.isVisible()) throw Error('Failed step prevented work from collapsing');
  await summary.click();
  await failure.waitFor({ state: 'visible' });
  await summary.click();
  if (await failure.isVisible()) throw Error('Completed work could not be collapsed');
  await page.reload();
  await page.getByText('1 failed step', { exact: false }).waitFor();
  if (await failure.isVisible()) throw Error('Reload expanded completed work with a failed step');
  await page.getByText('Second final answer part.', { exact: true }).waitFor();
}
