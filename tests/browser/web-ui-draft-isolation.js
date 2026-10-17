// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  const stored = page.getByRole('button', { name: 'A new home for Shepherd', exact: true });
  const other = page.getByRole('button', { name: 'Paginated history', exact: true });
  const connected = page.getByRole('status', { name: 'Connected', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const picker = page.getByLabel('Choose images', { exact: true });
  const paste = async (text, start, end) => composer.evaluate((el, { text, start, end }) => {
    el.setSelectionRange(start, end);
    const data = new DataTransfer(); data.setData('text/plain', text);
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'audit.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data }); el.dispatchEvent(event);
  }, { text, start, end });
  await stored.click(); await connected.waitFor();
  await composer.fill('Before old after');
  await paste('Caption', 7, 10);
  await page.getByRole('button', { name: 'Remove audit.png', exact: true }).waitFor();
  if (await composer.inputValue() !== 'Before Caption after') throw Error('Mixed paste lost text or replaced the wrong selection');
  if (await composer.evaluate(el => el.selectionStart) !== 14) throw Error('Mixed paste moved the cursor incorrectly');
  await page.getByRole('button', { name: 'Remove audit.png', exact: true }).click();
  await composer.fill('x'.repeat(32765));
  await paste('Long caption', 32765, 32765);
  await page.getByRole('button', { name: 'Remove audit.png', exact: true }).waitFor();
  if ((await composer.inputValue()).length !== 32768 || !(await composer.inputValue()).endsWith('Lon')) throw Error('Mixed paste exceeded the text limit');
  await page.getByRole('button', { name: 'Remove audit.png', exact: true }).click();

  let releaseSend, receivedSend;
  const receipt = new Promise(resolve => { receivedSend = resolve; });
  await page.route('**/api/conversations/*/messages', async route => {
    const response = await route.fetch();
    const pending = new Promise(resolve => { releaseSend = resolve; }); receivedSend();
    await pending; await route.fulfill({ response });
  });
  await composer.fill('Same text for a new draft');
  await picker.setInputFiles('/tmp/shepherd-image-input-fixtures/first.png');
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await receipt;
  await other.click(); await connected.waitFor(); await stored.click(); await connected.waitFor();
  await composer.fill('Replacement draft'); await composer.fill('Same text for a new draft');
  await picker.setInputFiles('/tmp/shepherd-image-input-fixtures/only.png');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  const delivered = page.waitForResponse(response => response.url().endsWith('/messages')); releaseSend(); await delivered;
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor({ state: 'hidden' });
  if (await composer.inputValue() !== 'Same text for a new draft') throw Error('Old send receipt cleared a newer draft with matching text');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });

  let releaseDetach, receivedDetach;
  const detached = new Promise(resolve => { receivedDetach = resolve; });
  await page.route('**/api/conversations/*', async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    const response = await route.fetch();
    const pending = new Promise(resolve => { releaseDetach = resolve; }); receivedDetach();
    await pending; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /Detach conversation/ }).click(); await detached;
  await other.click(); await connected.waitFor();
  await composer.fill('Keep the selected chat draft');
  const detachResponse = page.waitForResponse(response => response.request().method() === 'DELETE'); releaseDetach(); await detachResponse;
  // The refreshed list follows completion of detach; waiting for its button
  // ensures the old request's selection cleanup has already run.
  await page.getByRole('button', { name: 'Refresh conversations', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[aria-label="Refresh conversations"]').getAttribute('aria-busy') === 'false');
  if (await page.locator('.main-header h1').textContent() !== 'Paginated history') throw Error('Detach completion closed another chat');
  if (await composer.inputValue() !== 'Keep the selected chat draft') throw Error('Detach completion lost another chat draft');
  if (await page.evaluate(() => JSON.parse(localStorage.getItem('shepherd.selection'))?.threadId) !== 'paged') throw Error('Detach completion removed the new saved selection');
  await page.unrouteAll({ behavior: 'wait' });
  await stored.click(); await connected.waitFor();
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /Detach conversation/ }).click();
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  if (await page.evaluate(() => localStorage.getItem('shepherd.selection')) !== null) throw Error('Detaching the selected chat kept its saved selection');
  return 'Mixed paste preserves text, selection and length limits; matching newer drafts and unsent images survive old receipts; detach preserves another chat and its saved selection';
}
