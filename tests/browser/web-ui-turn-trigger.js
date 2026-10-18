// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('background wake');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // A turn the agent's background work started says so; the person's own turn does not.
  await page.getByText('Background result ready.', { exact: true }).waitFor();
  const label = page.getByText('Started when background work finished', { exact: true });
  await label.waitFor();
  if (await label.count() !== 1) throw Error('The background label should mark only the woken turn');
  await page.reload();
  await page.getByText('Background result ready.', { exact: true }).waitFor();
  await label.waitFor();
  if (await label.count() !== 1) throw Error('The background label did not survive a reload exactly once');
}
