// Run against a fresh web-ui-host fixture in Firefox.
async page => {
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('same key')) errors.push(message.text()); });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  for (const suffix of ['one', 'two']) {
    await composer.fill(`opaque repeated stream ${suffix}`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Repeated prefix again', { exact: true }).last().waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message Shepherd"]').value === '');
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    const count = suffix === 'one' ? 1 : 2;
    await page.waitForFunction(expected => [...document.querySelectorAll('.message-user')].filter(el => el.textContent.includes('Revert from here')).length >= expected + 1, count);
    if (await page.getByText('Repeated prefix', { exact: true }).count() !== count) throw Error('Established repeated answer was erased');
    if (await page.getByText('Repeated prefix again', { exact: true }).count() !== count) throw Error('Anonymous repeated answer was duplicated');
    if (await page.locator('.message-user').filter({ hasText: `opaque repeated stream ${suffix}` }).count() !== 1) throw Error('Native local-prefixed request duplicated');
  }
  await page.reload();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByText('Repeated prefix again', { exact: true }).last().waitFor();
  if (await page.getByText('Repeated prefix', { exact: true }).count() !== 2) throw Error('Repeated answer lost after reload');
  await page.getByRole('button', { name: 'Attachment history', exact: true }).click();
  await page.getByText('[Attachment: recording.wav]', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Revert from here', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('[Attachment: recording.wav]', { exact: true }).waitFor();
  if (errors.length) throw Error(errors.join('\n'));
  return 'Opaque turn IDs, repeated anonymous text, canonical replay, local-prefixed Revert, reload and attachment history passed';
}
