// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
  const file = name => `/tmp/shepherd-image-input-fixtures/${name}`;
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const picker = page.getByLabel('Choose images', { exact: true });
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  await picker.setInputFiles(file('bad.svg'));
  await page.getByText('Convert other formats before attaching.', { exact: false }).waitFor();
  await picker.setInputFiles([file('first.png'), file('second.png')]);
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove second.png', exact: true }).click();
  await composer.fill('Describe the attached image');
  await page.route('**/api/v1/conversations/*/messages', route => route.fulfill({ status: 502, json: { error: { code: 'operation_failed', message: 'Image send failed' } } }));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Image send failed', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor();
  if (await composer.inputValue() !== 'Describe the attached image') throw Error('Text draft lost on failure');
  await page.unroute('**/api/v1/conversations/*/messages');
  const posted = page.waitForRequest(request => request.url().endsWith('/messages') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const body = (await posted).postDataJSON();
  if (body.images.length !== 1 || !body.images[0].startsWith('data:image/png;base64,')) throw Error('Image not forwarded');
  await page.getByRole('img', { name: 'Attached image 1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove first.png', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('img', { name: 'Attached image 1', exact: true }).waitFor();
  await picker.setInputFiles(file('only.png'));
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled())) throw Error('Image-only send disabled');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => [...document.querySelectorAll('img[alt="Attached image 1"]')].length === 2);
  // Clipboard input uses the same validation/preview path as file selection.
  await composer.evaluate((element, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'pasted.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    element.dispatchEvent(event);
  }, base64);
  await page.getByRole('button', { name: 'Remove pasted.png', exact: true }).waitFor();
  await composer.evaluate((element, base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], 'dropped.png', { type: 'image/png' }));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: data });
    element.closest('form').dispatchEvent(event);
  }, base64);
  await page.getByRole('button', { name: 'Remove dropped.png', exact: true }).click();
  await picker.setInputFiles([file('2.png'), file('3.png'), file('4.png'), file('5.png')]);
  await page.getByText('Attach up to four images per message.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove pasted.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await page.getByRole('heading', { name: 'Fork copy', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Remove pasted.png', exact: true }).count()) throw Error('Draft leaked into fork');
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('button', { name: 'Remove pasted.png', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  await composer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/shepherd-image-input-mobile.png' });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Image composer overflow');
}
