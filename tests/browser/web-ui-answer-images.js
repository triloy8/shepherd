// Run with playwright-cli run-code against the isolated web-ui-host fixture.
async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Shepherd' }).fill('answer screenshot');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const image = page.locator('.message-assistant').getByRole('img', { name: 'Desktop view', exact: true });
  await image.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.message-assistant img[alt="Desktop view"]');
    return img?.complete && img.naturalWidth > 0;
  });
  const url = await image.getAttribute('src');
  if (!/^\/api\/conversations\/[\w-]+\/images\/[\w-]+$/.test(url)) throw Error('Answer used an unregistered image URL');
  if (await page.getByRole('link', { name: 'Open the original screenshot', exact: true }).getAttribute('href') !== url) throw Error('File link did not resolve to the same image');
  await page.locator('.progress-disclosure > summary').first().waitFor();
  if (!await image.isVisible()) throw Error('Answer image was folded into work');
  if (await page.locator('.viewed-image-disclosure img').isVisible()) throw Error('Work screenshot remained expanded');
  const [fullSize] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('.message-assistant').getByRole('link', { name: 'Open image: desktop-screenshot.png', exact: true }).click(),
  ]);
  await fullSize.waitForLoadState();
  if (fullSize.url() !== new URL(url, page.url()).href) throw Error('Full-size image opened a different asset');
  await fullSize.close();
  await page.reload();
  await image.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.message-assistant img[alt="Desktop view"]');
    return img?.complete && img.naturalWidth > 0;
  });
  if (!await image.isVisible()) throw Error('Reload folded the answer image into work');
  if (await page.locator('.viewed-image-disclosure img').isVisible()) throw Error('Reload expanded the work screenshot');
  if (await image.getAttribute('src') !== url) throw Error('Reload changed the registered image');
  if (await image.count() !== 1) throw Error('Answer duplicated its image');
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Inline image caused mobile overflow');
}
