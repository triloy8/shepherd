// Shared stream IDs can be missing initially, and native item IDs may repeat in later turns.
async page => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('same key')) errors.push(message.text()); });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  for (const suffix of ['one', 'two']) {
    const input = `portable stream ${suffix}`;
    const answer = `Portable answer: ${input}`;
    await composer.fill(input);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const output = page.locator('.assistant-response .message-assistant').filter({ hasText: answer });
    await output.getByText('Writing…', { exact: true }).waitFor();
    await output.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
    if (await output.count() !== 1) throw Error('Anonymous stream duplicated at completion');
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Shepherd"]').value === '');
  }
  const check = async () => {
    for (const suffix of ['one', 'two']) {
      if (await page.locator('.assistant-response .message-assistant').filter({ hasText: `Portable answer: portable stream ${suffix}` }).count() !== 1) throw Error('Reused history item ID erased or duplicated an answer');
      if (await page.locator('.message-user').filter({ hasText: `portable stream ${suffix}` }).count() !== 1) throw Error('Reused user ID erased or duplicated a request');
    }
    if ((await page.locator('.assistant-response').allTextContents()).some(text => text.includes('I’ll check the project first.'))) throw Error('Completed interim message became a final answer');
  };
  await check();
  await page.reload();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByText('Portable answer: portable stream two', { exact: true }).waitFor();
  await check();
  await page.setViewportSize({ width: 390, height: 844 });
  await check();
  if (errors.length) throw Error(errors.join('\n'));
  return 'Anonymous stream reconciliation, nullable turn correlation, repeated native IDs, interim phases, reload and mobile passed';
}
