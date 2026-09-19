// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('parity approval');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  await page.getByText('I’ll check the project first.', { exact: true }).waitFor();
  if (await page.locator('.progress-disclosure').count()) throw Error('Live work folded');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.locator('.progress-disclosure summary').waitFor();
  await page.getByText('Second final answer part.', { exact: true }).waitFor();
  await page.getByText('Running command · Failed', { exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Copy response', exact: true }).count() !== 3) throw Error('Missing final answer copy controls');
  await page.getByRole('img', { name: 'Fixture image' }).waitFor();
  await page.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
  await page.locator('.progress-disclosure summary').click();
  await page.getByText('I’ll check the project first.', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Second final answer part.', { exact: true }).waitFor();
  await page.getByText('Running command · Failed', { exact: true }).waitFor();
  await page.getByRole('img', { name: 'Fixture image' }).waitFor();
  await page.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
  if (await page.getByText('I’ll check the project first.', { exact: true }).isVisible()) throw Error('Reload failed to fold progress');
  await page.route('**/images/*', route => route.fulfill({ status: 422, json: { error: { code: 'image_unavailable' } } }));
  await page.reload();
  await page.getByText('Generated image unavailable. Reload the conversation to retry.', { exact: true }).waitFor();
  await page.unroute('**/images/*');
  await page.reload();
  await page.getByRole('img', { name: 'Fixture image' }).waitFor();
  await page.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations', exact: true }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Narrow layout overflow');
}
