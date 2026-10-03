// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('generate unicorn');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const image = page.getByRole('img', { name: 'A white unicorn in an enchanted meadow', exact: true });
  await image.waitFor();
  await page.getByText('Your unicorn is ready.', { exact: true }).waitFor();
  const response = page.locator('.assistant-response').filter({ has: image });
  if (await response.getByText('Shepherd', { exact: true }).count() !== 1) throw Error('Generated response repeated or missed its author');
  if (!await response.getByText('Your unicorn is ready.', { exact: true }).isVisible()) throw Error('Image and final text were not grouped');
  const details = response.locator('.generation-details');
  if (await details.getAttribute('open') !== null) throw Error('Generation details started expanded');
  await details.locator('summary').click();
  await details.locator('p').waitFor({ state: 'visible' });
  await details.locator('summary').click();
  await page.reload();
  await image.waitFor();
  await response.getByText('Your unicorn is ready.', { exact: true }).waitFor();
  if (await response.getByText('Shepherd', { exact: true }).count() !== 1) throw Error('Reload broke the author grouping');
  if (await details.getAttribute('open') !== null) throw Error('Reload expanded generation details');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Generated response overflowed on mobile');
}
