// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  const stored = page.getByRole('button', { name: 'A new home for Shepherd', exact: true });
  const other = page.getByRole('button', { name: 'Paginated history', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const picker = page.getByLabel('Choose images', { exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const connected = page.getByRole('status', { name: 'Connected', exact: true });
  const image = name => `/tmp/shepherd-image-input-fixtures/${name}`;
  const empty = () => page.waitForFunction(() => document.querySelector('textarea').value === '' && !document.querySelector('.composer [aria-label="Attached images"]'), undefined, { timeout: 3000 });
  await stored.click(); await connected.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });

  let holdHistory = true;
  const releaseHistory = [];
  await page.route('**/api/v1/conversations/*/turns?*', async route => {
    if (holdHistory) await new Promise(resolve => releaseHistory.push(resolve));
    await route.continue();
  });
  await composer.fill('Clear before history catches up');
  await picker.setInputFiles(image('first.png'));
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor();
  await send.click();
  await empty();
  if (!releaseHistory.length) throw Error('History refresh was not delayed');
  holdHistory = false; releaseHistory.forEach(resolve => resolve());
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });

  let releaseSend;
  let receivedSend;
  let receipt = new Promise(resolve => { receivedSend = resolve; });
  await page.route('**/api/v1/conversations/*/messages', async route => {
    const response = await route.fetch();
    const pending = new Promise(resolve => { releaseSend = resolve; });
    receivedSend();
    await pending;
    await route.fulfill({ response });
  });
  await composer.fill('Clear the originating chat after switching');
  await picker.setInputFiles(image('first.png'));
  await send.click(); await receipt;
  await other.click(); await connected.waitFor();
  await composer.fill('Keep the other chat draft');
  await picker.setInputFiles(image('second.png'));
  await page.getByRole('button', { name: 'Remove second.png', exact: true }).waitFor();
  let delivered = page.waitForResponse(response => response.url().endsWith('/messages'));
  releaseSend(); await delivered;
  if (await composer.inputValue() !== 'Keep the other chat draft') throw Error('Cleared another chat’s text');
  await page.getByRole('button', { name: 'Remove second.png', exact: true }).waitFor();
  await stored.click(); await connected.waitFor(); await empty();

  receipt = new Promise(resolve => { receivedSend = resolve; });
  await composer.fill('Old submitted text');
  await picker.setInputFiles(image('first.png'));
  await send.click(); await receipt;
  await other.click(); await connected.waitFor();
  await stored.click(); await connected.waitFor();
  await composer.fill('Keep this new edit');
  await picker.setInputFiles(image('only.png'));
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  delivered = page.waitForResponse(response => response.url().endsWith('/messages'));
  releaseSend(); await delivered;
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor({ state: 'hidden' });
  if (await composer.inputValue() !== 'Keep this new edit') throw Error('Deleted text edited after switching back');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  await page.unroute('**/api/v1/conversations/*/messages');
  await page.getByRole('button', { name: 'Interrupt response', exact: true }).waitFor({ state: 'hidden' });

  await page.route('**/api/v1/conversations/*/messages', route => route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Send failed' } } }));
  await send.click();
  await page.getByRole('alert').filter({ hasText: 'Send failed' }).waitFor();
  if (await composer.inputValue() !== 'Keep this new edit') throw Error('Lost text after a rejected send');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  await page.unroute('**/api/v1/conversations/*/messages');
  return 'Accepted sends clear text/images without waiting for history, including after switching chats; newer edits and other-chat drafts survive; failed sends retain their draft';
}
