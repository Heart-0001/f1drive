const {app,BrowserWindow}=require('electron'); const fs=require('fs');
const VIEW=require('url').pathToFileURL(require('path').join(__dirname,'view.html')).href;
require('../../../electron-userdata')(app, 'track-audit-shot');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const shots=(process.env.SHOTS||'').split(',').filter(Boolean).map(s=>[s.slice(0,s.indexOf(':')),s.slice(s.indexOf(':')+1)]);
  const w=new BrowserWindow({width:1280,height:720,show:false,useContentSize:true,webPreferences:{offscreen:true}});
  w.webContents.on('console-message',(e,l,m)=>{ if(l>=2) console.log('CONSOLE',m); });
  for(const [n,qs] of shots){
    try{
    await w.loadURL(VIEW+qs);
    for(let k=0;k<60;k++){ await new Promise(r=>setTimeout(r,250)); if(/^(done|ERR)/.test(w.getTitle())) break; }
    await new Promise(r=>setTimeout(r,300));
    const img=await w.webContents.capturePage();
    fs.writeFileSync(__dirname+'/shot-'+n+'.png',img.toPNG());
    console.log(n,w.getTitle());
    }catch(e){console.log('ERR',n,e.message);}
  }
  app.exit(0);
});
