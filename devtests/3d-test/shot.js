const {app,BrowserWindow}=require('electron'); const fs=require('fs');
const VIEW=require('url').pathToFileURL(require('path').join(__dirname,'view.html')).href;
require('../electron-userdata')(app, '3d-shot');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const shots=(process.env.SHOTS||'a:?t=spa').split(',').map(s=>[s.slice(0,s.indexOf(':')),s.slice(s.indexOf(':')+1)]);
  const w=new BrowserWindow({width:1280,height:720,show:false,useContentSize:true,webPreferences:{offscreen:true}});
  for(const [n,qs] of shots){
    try{
    await w.loadURL(VIEW+qs);
    await new Promise(r=>setTimeout(r,1200));
    console.log(n, w.webContents.getTitle());
    const img=await w.webContents.capturePage();
    fs.writeFileSync(__dirname+'/shot-'+n+'.png',img.toPNG());
    }catch(e){console.log('ERR',n,e.message);}
  }
  app.exit(0);
});
