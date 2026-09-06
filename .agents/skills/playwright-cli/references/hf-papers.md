# Hugging Face Papers

Use this reference when the user wants content from `hf.co/papers` or `huggingface.co/papers`, especially if they want a Markdown digest with paper titles and abstracts.

## Scope

- Default to the currently visible daily feed page, for example `https://huggingface.co/papers/date/2026-03-13`.
- Treat the papers listed on that page as the scope unless the user asks for a different date or wants pagination followed.
- Prefer one dedicated session, for example `-s=hf-papers`.

## Recommended approach

- Open the feed in a dedicated session.
- Do not click every paper manually.
- Use `run-code` to:
  - extract and deduplicate paper links from the daily feed
  - fetch each paper page
  - parse title and abstract from the returned HTML
- Write the final result to Markdown if the user asked for a file.

## Feed parsing rules

Extract links from `a[href^="/papers/"]` and filter aggressively:

- Ignore links containing `#community`
- Ignore links containing `/date/`
- Ignore entries whose text is only digits
- Ignore entries whose text matches author-count strings like `· 5 authors`
- Deduplicate by final paper URL

This avoids counting vote totals, community counts, author chips, and pagination links as papers.

## Paper-page parsing rules

For each paper page:

- `title`: take the `h1`
- `abstract`:
  - find the `h2` whose text is exactly `Abstract`
  - inspect its immediate next sibling wrapper
  - collect `p` elements under that wrapper
  - use the longest paragraph as the abstract

This matters because Hugging Face paper pages often put an AI-generated summary and the full abstract inside the same wrapper. Picking the longest paragraph reliably gets the actual abstract instead of the short summary.

## Output shape

If the user asks for a Markdown file, use:

```md
# Hugging Face Daily Papers

Source: <daily-feed-url>

Extracted <count> paper titles and abstracts from the Hugging Face daily papers feed.

## <paper title>

URL: <paper-url>

<abstract>
```

Use one `##` section per paper.

## Working extraction example

```bash
playwright-cli -s=hf-papers open https://hf.co/papers --browser=firefox
playwright-cli -s=hf-papers run-code "async page => JSON.stringify(await page.evaluate(async () => {
  const seen = new Set();
  const items = Array.from(document.querySelectorAll('a[href^=\"/papers/\"]'))
    .map(a => ({ href: a.href, text: (a.textContent || '').trim() }))
    .filter(({ href, text }) => {
      if (!text || href.includes('#community') || href.includes('/date/')) return false;
      if (/^\\d+$/.test(text)) return false;
      if (/^·\\s*\\d+\\s+authors?$/.test(text)) return false;
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    });

  const results = [];
  for (const item of items) {
    const html = await fetch(item.href).then(r => r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('h1')?.textContent?.trim() || item.text;
    const abstractHeading = Array.from(doc.querySelectorAll('h2'))
      .find(h => (h.textContent || '').trim() === 'Abstract');
    let abstract = '';
    if (abstractHeading?.nextElementSibling) {
      const paragraphs = Array.from(abstractHeading.nextElementSibling.querySelectorAll('p'))
        .map(p => (p.textContent || '').trim())
        .filter(Boolean);
      abstract = paragraphs.sort((a, b) => b.length - a.length)[0] || '';
    }
    results.push({ title, url: item.href, abstract });
  }
  return results;
}))"
```

## Notes

- `run-code` should use `page.evaluate(...)` when DOM globals like `document` are needed.
- If the user wants a repo file, convert the JSON result to Markdown and then write the requested destination.
- If the user asks for “each paper” without more detail, interpret that as each paper on the current daily feed page, not every paper in Hugging Face Papers history.
