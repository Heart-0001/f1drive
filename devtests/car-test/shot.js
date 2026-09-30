const {app,BrowserWindow}=require('electron'); const fs=require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const shots=(process.env.SHOTS||'a:?v=0,b:?v=90&steer=1,c:?ext=1&steer=-1').split(',').map(s=>[s.slice(0,s.indexOf(':')),s.slice(s.indexOf(':')+1)]);
  const w=new BrowserWindow({width:1280,height:720,show:false,useContentSize:true,webPreferences:{offscreen:true}});
  for(const [n,qs] of shots){
    try{
    await w.loadURL('file:///C:/Users/user/AppData/Local/Temp/f1drive-car-test/view.html'+qs);
    await new Promise(r=>setTimeout(r,800));
    const img=await w.webContents.capturePage();
    fs.writeFileSync(__dirname+'/shot-'+n+'.png',img.toPNG());
    }catch(e){console.log('ERR',n,e.message);}
  }
  app.exit(0);
});
