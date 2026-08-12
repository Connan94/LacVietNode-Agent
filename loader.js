// ============================================================
//  loader.js — Bộ giám sát + TỰ CẬP NHẬT cho Lạc Việt Node Agent (SoloHost)
//  - Chạy app.js, nếu app thoát thì chạy lại.
//  - Định kỳ hỏi server bản mới; có thì tải bundle mới về /data/bundle rồi khởi động lại.
//  - Dùng Node https (KHÔNG qua proxy hệ thống) -> MIỄN NHIỄM lỗi proxy của bản .exe cũ.
//  - Nếu server không với tới được -> vẫn chạy bản hiện có (baked trong image).
// ============================================================
'use strict';
const https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');

const DATA       = process.env.DATA_DIR || '/data';
const SERVER     = (process.env.SERVER || 'app.lacviet-node.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
const BUNDLE_DIR = path.join(DATA, 'bundle');
const BAKED      = path.join(__dirname, 'app.js');           // bản đóng kèm image (fallback)
const CHECK_MS   = 30 * 60 * 1000;                            // kiểm tra cập nhật mỗi 30 phút
let child = null, curVer = null, stopping = false;

function log(m){ console.log('[loader] ' + m); }

function getJSON(p){
  return new Promise(function(res){
    const req = https.get({ host:SERVER, path:p, headers:{ 'User-Agent':'lacviet-loader' } }, function(r){
      let b=''; r.on('data',d=>b+=d); r.on('end', function(){ try{ res(JSON.parse(b)); }catch(e){ res(null); } });
    });
    req.on('error', function(){ res(null); });
    req.setTimeout(10000, function(){ try{req.destroy();}catch(e){} res(null); });
  });
}
function download(p, dest){
  return new Promise(function(res, rej){
    const f = fs.createWriteStream(dest);
    const req = https.get({ host:SERVER, path:p, headers:{ 'User-Agent':'lacviet-loader' } }, function(r){
      if(r.statusCode !== 200){ rej(new Error('http '+r.statusCode)); return; }
      r.pipe(f); f.on('finish', function(){ f.close(function(){ res(); }); });
    });
    req.on('error', rej);
    req.setTimeout(60000, function(){ try{req.destroy();}catch(e){} rej(new Error('timeout')); });
  });
}

function currentAppPath(){
  const dl = path.join(BUNDLE_DIR, 'app.js');
  try { if(fs.existsSync(dl) && fs.statSync(dl).size > 500) return dl; } catch(e){}
  return BAKED;
}
function run(){
  const p = currentAppPath();
  log('chạy ' + p);
  child = spawn(process.execPath, [p], { stdio:'inherit', env:process.env });
  child.on('exit', function(code){
    child = null;
    if(stopping) return;
    log('app thoát (' + code + '), chạy lại sau 3s');
    setTimeout(run, 3000);
  });
}
function restartForUpdate(){ if(child){ log('khởi động lại để áp bản mới'); child.kill('SIGTERM'); } else run(); }

async function checkUpdate(){
  try {
    const m = await getJSON('/api/solohost/version');
    if(!m || !m.version || !m.url){ return; }          // chưa có manifest -> bỏ qua, giữ bản hiện tại
    if(m.version === curVer) return;
    log('có bản mới: ' + m.version);
    fs.mkdirSync(BUNDLE_DIR, { recursive:true });
    const tmp = path.join(BUNDLE_DIR, 'app.new.js');
    // Chỉ tải TỪ ĐÚNG server qua HTTPS (m.url là path, không theo redirect ngoài).
    await download(m.url, tmp);
    if(fs.statSync(tmp).size < 500){ log('bundle quá nhỏ, bỏ'); try{fs.unlinkSync(tmp);}catch(e){} return; }
    // BẢO MẬT: bắt buộc khớp SHA256 trong manifest -> chống bundle hỏng / bị đầu độc cache.
    if(m.sha256){
      const got = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex').toLowerCase();
      if(got !== String(m.sha256).toLowerCase()){ log('SHA256 KHONG KHOP -> bo ban tai (nghi bi thay doi)'); try{fs.unlinkSync(tmp);}catch(e){} return; }
    } else {
      log('CANH BAO: manifest khong co sha256 -> nen them de bao mat');
    }
    fs.renameSync(tmp, path.join(BUNDLE_DIR, 'app.js'));
    curVer = m.version; log('đã cập nhật bundle -> ' + m.version);
    restartForUpdate();
  } catch(e){ log('kiểm tra cập nhật lỗi: ' + e.message); }
}

process.on('SIGTERM', function(){ stopping=true; if(child) child.kill('SIGTERM'); setTimeout(()=>process.exit(0), 500); });

run();
checkUpdate();
setInterval(checkUpdate, CHECK_MS);
