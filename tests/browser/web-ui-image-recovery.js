// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('heading', { name: 'A new home for Shepherd', exact: true }).waitFor();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  let loads = 0;
  await page.route('**/api/v1/conversations/*/images/*', async route => {
    loads++;
    if (loads <= 2) await route.fulfill({ status: 503, body: 'Temporary failure' });
    else await route.continue();
  });
  await page.getByRole('textbox', { name: 'Message Shepherd', exact: true }).fill('generate unicorn');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry image', exact: true });
  await retry.waitFor();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  if (loads !== 1) throw Error('Failed image entered a retry loop');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('status', { name: 'Reconnecting', exact: true }).waitFor();
  const retried = page.waitForResponse(response => response.url().includes('/images/'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await retried; await retry.waitFor();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  if (loads !== 2) throw Error('Reconnect did not retry exactly once');
  await retry.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.chat-content img')].some(image => image.complete && image.naturalWidth > 0));
  await retry.waitFor({ state: 'hidden' });
  if (loads !== 3) throw Error('Explicit retry did not recover the image');
  await page.unrouteAll({ behavior: 'wait' });
  return 'Image failures retry once on reconnect and recover through an explicit retry without a reload or retry loop';
}
