// Run: npm install --no-save playwright@1.55.0
// Start: python3 -m http.server 8765 --bind 127.0.0.1
// Then: node tests/perf/benchmark.mjs
//
// Informational benchmark only: no arbitrary speed thresholds or NAS writes.
import { chromium } from 'playwright';

const ORIGIN = process.env.UFS_TEST_ORIGIN || 'http://127.0.0.1:8765';
const counts = [100, 1000, 10000];
const html = '<!doctype html><html><head><meta charset="utf-8"><style>'+
  'body{margin:0;font-family:Arial,sans-serif}#header{height:75px}#footer{position:fixed;bottom:0;width:100%;height:24px}'+
  '</style></head><body><div id="header">Unraid Browser Benchmark</div>'+
  '<div class="autoheight"><table class="indexer"><tr><td>Native</td></tr></table></div>'+
  '<div id="footer">Array Started</div>'+
  '<script src="/src/unraid-file-station.user.js"></script></body></html>';

function fixtureRows(count) {
  let out = '<tbody>';
  for (let i=0; i<count; i++) {
    const name='file-'+String(i).padStart(5,'0')+'.txt';
    const path='/mnt/user/benchmark/'+name;
    out += '<tr><td><i id="row_'+i+'" type="f" data="'+path+'"></i></td>'+
      '<td>'+name+'</td><td></td><td>nobody</td><td>-rw-rw-rw-</td>'+
      '<td data="2048">2048</td><td data="1791435600">date</td>'+
      '<td><span id="device_'+i+'">disk2</span></td></tr>';
  }
  return out+'</tbody>';
}

const browser = await chromium.launch({headless:true, args:['--enable-precise-memory-info']});
try {
  for (const count of counts) {
    const context = await browser.newContext({viewport:{width:1440,height:900}});
    const page = await context.newPage();
    const failures=[];
    page.on('pageerror',err=>failures.push(err.message));
    await page.route('**/Shares/Browse?*',route=>route.fulfill({contentType:'text/html',body:html}));
    const payload=fixtureRows(count);
    await page.route('**/webGui/include/Browse.php?*',route=>{
      const query=new URL(route.request().url()).searchParams;
      const path=decodeURIComponent(query.get('dir')||'');
      return route.fulfill({contentType:'text/html',body:path==='/mnt/user/benchmark'?payload:'<tbody></tbody>'});
    });
    const start=Date.now();
    await page.goto(ORIGIN+'/Shares/Browse?dir=%2Fmnt%2Fuser%2Fbenchmark');
    await page.waitForFunction(count => {
      const app=document.querySelector('#ufs-app');
      const mounted=app?.querySelectorAll('.ufs-entry').length || 0;
      const label=app?.querySelector('.ufs-count')?.textContent || '';
      return label.startsWith(count + ' 个项目') && mounted > 0 &&
        (count <= 200 ? mounted === count : mounted < count);
    },count,{timeout:120000});
    const elapsedMs=Date.now()-start;
    const metrics=await page.evaluate(()=>{
      const list=document.querySelector('.ufs-list');
      return {
        rowCount:document.querySelectorAll('.ufs-entry').length,
        totalCount:document.querySelector('.ufs-count')?.textContent,
        virtualized:document.querySelector('.ufs-list')?.classList.contains('ufs-virtualized'),
        domNodes:document.querySelectorAll('#ufs-app *').length,
        heapMB:performance.memory ? Number((performance.memory.usedJSHeapSize/1024/1024).toFixed(1)) : null,
        horizontalOverflow:Math.max(0,list.scrollWidth-list.clientWidth),
        verticalOverflow:Math.max(0,list.scrollHeight-list.clientHeight)
      };
    });
    if (count>200) {
      if (metrics.rowCount >= count || metrics.rowCount > 300) {
        throw new Error('Virtual list mounted excessive DOM rows: ' + metrics.rowCount);
      }
      await page.evaluate(() => {
        const list=document.querySelector('.ufs-list');
        list.scrollTop=list.scrollHeight;
      });
      const last='file-'+String(count-1).padStart(5,'0')+'.txt';
      await page.waitForFunction(last => {
        return [...document.querySelectorAll('.ufs-entry .ufs-filename')]
          .some(node => node.textContent === last);
      },last,{timeout:15000});
    }
    console.log(JSON.stringify({files:count,elapsedMs,...metrics,errors:failures}));
    if(failures.length)throw new Error('浏览器脚本异常: '+failures.join('; '));
    await context.close();
  }
} finally {
  await browser.close();
}
