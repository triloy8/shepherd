// Run against the isolated web-ui-host fixture using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.getByRole('status', { name: 'Connected', exact: true }).waitFor();
  const input = page.getByRole('textbox', { name: 'Message Shepherd', exact: true });
  const row = page.locator('.composer-input');
  await input.fill('');
  await page.waitForFunction(() => !document.querySelector('.composer-expanded'));
  const geometry = await row.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { height: r.height, buttons: [...el.querySelectorAll('button')].map(b => b.getBoundingClientRect().height) };
  });
  if (geometry.height !== 60 || geometry.buttons.some(h => h !== 44)) throw Error(JSON.stringify(geometry));
  await page.screenshot({ path: '/tmp/shepherd-chatbox-compact-mobile.png' });
  await input.fill('A longer draft should wrap across multiple lines on a phone while the plus and send controls stay beneath the text.');
  await page.waitForFunction(() => !!document.querySelector('.composer-expanded'));
  const belowText = await row.evaluate(el => el.querySelector('button').getBoundingClientRect().top >= el.querySelector('textarea').getBoundingClientRect().bottom);
  if (!belowText) throw Error('Expanded actions overlap text');
  await page.screenshot({ path: '/tmp/shepherd-chatbox-expanded-mobile.png' });
  await input.fill('First line\nSecond line');
  await page.waitForFunction(() => !!document.querySelector('.composer-expanded'));
  await input.fill('Short');
  await page.waitForFunction(() => !document.querySelector('.composer-expanded'));
  await input.fill('A very long draft line\n'.repeat(40));
  if (!await input.evaluate(el => el.scrollHeight > el.clientHeight)) throw Error('Long draft does not scroll');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow');
  await input.fill('');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !document.querySelector('.composer-expanded'));
  await page.screenshot({ path: '/tmp/shepherd-chatbox-desktop.png' });
  await input.fill('This draft fits on desktop and wraps when the viewport narrows.');
  await page.waitForFunction(() => !document.querySelector('.composer-expanded'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !!document.querySelector('.composer-expanded'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !document.querySelector('.composer-expanded'));
  await input.fill('');
  return geometry;
}
