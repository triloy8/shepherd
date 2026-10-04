// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const stop = page.getByRole('button', { name: 'Interrupt response', exact: true });
  if (await send.isEnabled()) throw Error('Empty idle send enabled');
  await composer.fill('approval to keep this turn active');
  await send.click();
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  await stop.waitFor();
  if (await page.locator('.composer .send-button').count() !== 1) throw Error('Multiple composer actions');
  await composer.press('Enter');
  await stop.waitFor(); // Empty Enter must not interrupt.
  await composer.fill('follow-up draft');
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).waitFor();
  if (await stop.count()) throw Error('Stop displaced a text draft');
  const followupResponse = page.waitForResponse(response => response.url().endsWith('/messages') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  const result = await (await followupResponse).json();
  if (result.type !== 'steer') throw Error('Follow-up started another turn');
  await stop.waitFor();
  await page.getByLabel('Choose images', { exact: true }).setInputFiles('/tmp/shepherd-image-input-fixtures/only.png');
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).waitFor();
  if (await stop.count()) throw Error('Image-only draft treated as empty');
  await page.getByRole('button', { name: 'Remove only.png', exact: true }).click();
  await stop.waitFor();
  const color = await stop.evaluate(el => getComputedStyle(el).color);
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());
  if (!color || !accent) throw Error('Stop theme missing');
  await stop.click();
  await page.getByText('Connected', { exact: true }).waitFor();
  if (await send.isEnabled()) throw Error('Idle empty action did not restore disabled send');
  await composer.fill('approval mobile'); await send.click();
  await page.getByRole('button', { name: 'Allow once', exact: true }).last().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await stop.click(); await page.getByText('Connected', { exact: true }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Composer mobile overflow');
  return 'One themed action switches correctly for text/image drafts, stops desktop/mobile work, and empty Enter never interrupts';
}
