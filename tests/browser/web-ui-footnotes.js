// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async (page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/conversations/*/turns?*', async route => {
    const response = await route.fetch();
    const history = await response.json();
    if (history.data?.length) {
      const text = index => `Message ${index} reference[^same]. Inline math: $E = mc^2$.\n\n${Array.from({ length: 25 }, (_, row) => `Paragraph ${index}.${row}: enough content to require scrolling within the conversation.`).join('\n\n')}\n\n[^same]: Note for message ${index}.`;
      history.data[0].items = [1, 2].map(index => ({ id: `footnote-${index}`, type: 'agentMessage', phase: 'final_answer', text: text(index) }));
    }
    await route.fulfill({ response, json: history });
  });
  await page.goto('http://127.0.0.1:8799');
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await page.getByRole('button', { name: 'A new home for Shepherd', exact: true }).click();
  await page.locator('a[data-footnote-ref]').nth(1).waitFor();
  await page.evaluate(() => { document.querySelector('.chat-scroll').scrollTop = 0; });
  const baseline = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    return { header: box('.main-header'), composer: box('.composer'), url: location.href };
  });
  const refs = await page.locator('a[data-footnote-ref]').count();
  for (let index = 0; index < refs; index++) {
    // Avoid Playwright's own ancestor scrolling when bringing links into view.
    await page.locator('a[data-footnote-ref]').nth(index).evaluate(link => {
      const scroll = link.closest('.chat-scroll');
      scroll.scrollTop += link.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16;
    });
    const before = await page.locator('.chat-scroll').evaluate(el => el.scrollTop);
    await page.locator('a[data-footnote-ref]').nth(index).evaluate(el => el.click());
    const forward = await page.locator('a[data-footnote-ref]').nth(index).evaluate(link => {
      const target = document.getElementById(decodeURIComponent(link.getAttribute('href').slice(1)));
      return { contained: link.closest('.message').contains(target), focused: document.activeElement === target, top: target.getBoundingClientRect().top, scrollTop: link.closest('.chat-scroll').scrollTop };
    });
    if (!forward.contained || !forward.focused || forward.scrollTop <= before) throw Error('Footnote did not scroll to its own message target');
    await page.locator('a[data-footnote-backref]').nth(index).evaluate(el => el.click());
    const returned = await page.locator('a[data-footnote-ref]').nth(index).evaluate(link => ({ focused: document.activeElement === link, scrollTop: link.closest('.chat-scroll').scrollTop }));
    if (!returned.focused || returned.scrollTop >= forward.scrollTop) throw Error('Return link did not scroll and focus its own reference');
    const after = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      return { header: box('.main-header'), composer: box('.composer'), url: location.href,
        outerScroll: [document.documentElement, document.body, document.querySelector('#root'), document.querySelector('.app-shell'), document.querySelector('.main-pane'), document.querySelector('.conversation-stage')].map(el => el.scrollTop) };
    });
    if (JSON.stringify(after.header) !== JSON.stringify(baseline.header) || JSON.stringify(after.composer) !== JSON.stringify(baseline.composer)) throw Error('Footnote navigation displaced the header or composer');
    if (after.url !== baseline.url || after.outerScroll.some(value => value !== 0)) throw Error('Footnote navigation scrolled the page or changed its fragment');
  }
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.message [id]')].map(el => el.id);
    return ids.length !== new Set(ids).size;
  });
  if (duplicateIds) throw Error('Messages share footnote IDs');
  const stylesheet = await page.locator('link[rel="stylesheet"]').getAttribute('href');
  const css = await (await page.request.get(new URL(stylesheet, page.url()).href)).text();
  if (/data:(?:font|application\/(?:font|x-font))/i.test(css)) throw Error('Math fonts are inlined and blocked by the host content policy');
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (!document.fonts.check('16px KaTeX_Main')) throw Error('Math font failed to load');
  });
  await page.unroute('**/api/conversations/*/turns?*');
  return 'Mobile footnote references and return links keep the header/composer fixed, scroll only the chat, focus the correct targets, and have distinct IDs across messages';
}
