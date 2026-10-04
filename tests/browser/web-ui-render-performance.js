// Run against tests/fixtures/web-ui-host.ts using playwright-cli run-code.
async page => {
  await page.unrouteAll({behavior:'wait'});
  await page.setViewportSize({width:1280,height:900});
  await page.goto('http://127.0.0.1:8799');
  const stored=page.getByRole('button',{name:'A new home for Shepherd',exact:true});
  await stored.click();
  await page.getByRole('heading',{name:'A new home for Shepherd',exact:true}).waitFor();
  await page.getByRole('status',{name:'Connected',exact:true}).waitFor();
  const measure=()=>page.getByRole('textbox',{name:'Message Shepherd',exact:true}).evaluate(async el=>{
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    const times=[];
    for(let i=0;i<8;i++){
      const start=performance.now();setter.call(el,'audit '+i);el.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      times.push(Math.round(performance.now()-start));
    }
    return times;
  });
  const shortChat=await measure();
  await page.route('**/api/v1/conversations/*/turns?*',async route=>{
    const response=await route.fetch();const body=await response.json();
    const text=('A history paragraph with **bold** and $x^2+y^2=z^2$ and $\\frac{a+b}{c}$.\n\n').repeat(10);
    body.data=Array.from({length:30},(_,i)=>({...body.data[0],id:'perf-turn-'+i,status:'completed',items:[{id:'perf-user-'+i,type:'userMessage',content:[{type:'text',text:'Question '+i}]},{id:'perf-assistant-'+i,type:'agentMessage',phase:'final_answer',text}]}));
    body.nextCursor=null;await route.fulfill({response,json:body});
  });
  await page.reload();await page.getByRole('status',{name:'Connected',exact:true}).waitFor();
  await page.locator('.katex').nth(599).waitFor();
  const longChat=await measure();
  if (Math.max(...longChat) > 500) throw Error('Typing reparsed heavy message history: '+JSON.stringify(longChat));
  // Resolve the button before timing: role queries themselves scan the large
  // accessibility tree and would distort measurements of application work.
  const sendButton = await page.getByRole('button', {name:'Send message',exact:true}).elementHandle();
  await page.evaluate(() => {
    window.auditFrames = new Promise(resolve => {
      const gaps = []; const start = performance.now(); let previous = start;
      const sample = time => { gaps.push(time - previous); previous = time; if (time - start < 1500) requestAnimationFrame(sample); else resolve(gaps); };
      requestAnimationFrame(sample);
    });
  });
  await sendButton.evaluate(button => button.click());
  const streamFrames = await page.evaluate(() => window.auditFrames);
  if (Math.max(...streamFrames) > 500) throw Error('Slow stream frames: '+JSON.stringify({shortChat,longChat,streamFrames}));
  await page.getByRole('button',{name:'Stop response',exact:true}).waitFor({state:'hidden'});
  await page.locator('.message-assistant pre').filter({hasText:'const surface = "web";'}).waitFor();
  return { shortChat, longChat, worstStreamFrame: Math.round(Math.max(...streamFrames)), mathExpressions: await page.locator('.katex').count() };
}
