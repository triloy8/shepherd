// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('view screenshot');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const image = page.getByRole('img', { name: 'desktop-screenshot.png', exact: true });
  const expandView = async () => {
    await page.locator('section[aria-label="Assistant turn"]').last().locator('.progress-disclosure > summary').click();
    await page.getByText('Viewed image · desktop-screenshot.png', { exact: true }).click();
  };
  await expandView();
  await image.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('img[alt="desktop-screenshot.png"]');
    return img?.complete && img.naturalWidth > 0;
  });
  if (await image.count() !== 1) throw Error('Duplicate viewed image cards');
  const url = await image.getAttribute('src');
  const [fullSize] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Open image: desktop-screenshot.png', exact: true }).click(),
  ]);
  await fullSize.waitForLoadState();
  if (fullSize.url() !== new URL(url, page.url()).href) throw Error('Full-size image opened a different asset');
  await fullSize.close();
  await page.reload();
  await expandView();
  await image.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('img[alt="desktop-screenshot.png"]');
    return img?.complete && img.naturalWidth > 0;
  });
  if (await image.count() !== 1) throw Error('History duplicated the screenshot');
  if (await image.getAttribute('src') !== url) throw Error('History lost the screenshot asset');
  await page.route('**/images/*', route => route.fulfill({ status: 422, json: { error: { code: 'image_unavailable' } } }));
  await page.reload();
  await expandView();
  await page.getByRole('button', { name: 'Retry image', exact: true }).waitFor();
  await page.unroute('**/images/*');
  await page.reload();
  await expandView();
  await image.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Screenshot caused mobile overflow');
}
