// ============================================================
//  Lạc Việt Node — Agent giám sát node Pi (bản chạy trên SoloHost)
//  Nguyên tắc: CHỈ báo cái đo được thật. Không đo được -> "không rõ", KHÔNG bịa.
//   - Trạng thái node (chạy/proto/đồng bộ): đọc thật qua docker.sock (nếu được mount).
//   - Cổng RA INTERNET: lấy từ server /api/agent/portcheck (đúng cái web check).
//   - Cổng NỘI BỘ: dò host.docker.internal:31401-3 (node còn sống trên máy).
// ============================================================
'use strict';
const http = require('http'), net = require('net'), fs = require('fs'),
      path = require('path'), https = require('https'), os = require('os'), crypto = require('crypto');

const VERSION  = '1.0.6';
const DATA     = process.env.DATA_DIR || '/data';
const SERVER   = (process.env.SERVER || 'app.lacviet-node.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
const NODE_HOST= process.env.NODE_HOST || 'host.docker.internal';
const PORT     = parseInt(process.env.PORT || '8080', 10);
const REQUIRED = [31401, 31402, 31403];
const CFG      = path.join(DATA, 'config.json');
const SOCK     = '/var/run/docker.sock';

function loadCfg(){ try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch(e){ return {}; } }
function saveCfg(c){ try { fs.mkdirSync(DATA, { recursive:true }); } catch(e){} try { fs.writeFileSync(CFG, JSON.stringify(c)); } catch(e){} }
let cfg = loadCfg();
if (!cfg.key && process.env.NODE_KEY) { cfg.key = process.env.NODE_KEY.trim(); saveCfg(cfg); }
// [SEC] Mã máy cố định (1 token = 1 máy). Sinh 1 lần, lưu trong /data (theo cài đặt).
if (!cfg.machineId) {
  try { cfg.machineId = crypto.randomUUID(); } catch(e){ cfg.machineId = crypto.randomBytes(16).toString('hex'); }
  saveCfg(cfg);
}

// ---------- dò cổng TCP ----------
function probe(host, port, timeout){
  return new Promise(function(res){
    const s = new net.Socket(); let done = false;
    const fin = function(v){ if(done) return; done = true; try{ s.destroy(); }catch(e){} res(v); };
    s.setTimeout(timeout || 1500);
    s.once('connect', function(){ fin(true); });
    s.once('timeout',  function(){ fin(false); });
    s.once('error',    function(){ fin(false); });
    try { s.connect(port, host); } catch(e){ fin(false); }
  });
}
async function localOpen(){                 // cổng node listen trên host (node còn sống)
  const open = [];
  await Promise.all(REQUIRED.map(async function(p){ if (await probe(NODE_HOST, p, 1500)) open.push(p); }));
  return open.sort(function(a,b){ return a-b; });
}

// ---------- IP công cộng ----------
function pubIp(){
  return new Promise(function(res){
    const req = https.get('https://api.ipify.org', function(r){ let b=''; r.on('data',d=>b+=d);
      r.on('end',function(){ b=(b||'').trim(); res(/^\d{1,3}(\.\d{1,3}){3}$/.test(b) ? b : ''); }); });
    req.on('error', function(){ res(''); }); req.setTimeout(6000, function(){ try{req.destroy();}catch(e){} res(''); });
  });
}

// ---------- tài nguyên (từ /proc — trong container = môi trường Docker) ----------
function fmtUp(s){ const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600); return (d>0?d+' ngày ':'')+h+' giờ'; }
// CPU% THẬT: lấy mẫu /proc/stat theo delta (không dùng loadavg thô)
function _readStat(){
  try {
    const line = fs.readFileSync('/proc/stat','utf8').split('\n')[0]; // "cpu  user nice sys idle iowait ..."
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (p[3]||0) + (p[4]||0);
    const total = p.reduce(function(a,b){ return a+(b||0); }, 0);
    return { idle:idle, total:total };
  } catch(e){ return null; }
}
let _cpuPct = null;
async function _cpuSampler(){
  let prev = _readStat();
  while(true){
    await wait(2000);
    const cur = _readStat();
    if(prev && cur){ const dt = cur.total-prev.total, di = cur.idle-prev.idle;
      if(dt>0) _cpuPct = Math.max(0, Math.min(100, Math.round((1 - di/dt)*100))); }
    prev = cur;
  }
}
function hostRes(){
  let ram=null, up=null, memTotalKB=0;
  try { up = fmtUp(parseFloat(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])); } catch(e){}
  try { const mi=fs.readFileSync('/proc/meminfo','utf8');
        const g=k=>{ const m=mi.match(new RegExp(k+':\\s+(\\d+)')); return m?parseInt(m[1],10):0; };
        memTotalKB=g('MemTotal'); const av=g('MemAvailable'); if(memTotalKB) ram=Math.round((1-av/memTotalKB)*100); } catch(e){}
  return { cpu:_cpuPct, ram:ram, uptime:up, memGB: memTotalKB? +(memTotalKB/1048576).toFixed(1) : null, cores:(os.cpus()||[]).length };
}
// docker.sock /info: tổng CPU/RAM + phân biệt Docker Desktop (máy ảo) vs Linux thật
let _infoCache=null, _infoAt=0;
async function dockerInfo(){
  if(_infoCache && (Date.now()-_infoAt)<60000) return _infoCache;
  const r = await sockReq('GET','/info');
  if(!r || r.status!==200) return null;
  try { const j=JSON.parse(r.body);
    _infoCache = { os:(j.OperatingSystem||''), ncpu:j.NCPU||null, memGB: j.MemTotal? +(j.MemTotal/1073741824).toFixed(1):null,
      isDesktop: /Docker Desktop/i.test(j.OperatingSystem||'') };
    _infoAt = Date.now(); return _infoCache;
  } catch(e){ return null; }
}

// ---------- docker.sock: trạng thái node THẬT ----------
function sockReq(method, pathname, payload){
  return new Promise(function(resolve){
    let hasSock=false; try{ hasSock=fs.existsSync(SOCK); }catch(e){}
    if(!hasSock) return resolve(null);
    const data = payload!=null ? JSON.stringify(payload) : null;
    const opt = { socketPath:SOCK, path:pathname, method:method,
      headers: data ? { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) } : {} };
    const req = http.request(opt, function(r){ let b=''; r.on('data',d=>b+=d); r.on('end',()=>resolve({ status:r.statusCode, body:b })); });
    req.on('error', function(){ resolve(null); });
    req.setTimeout(4000, function(){ try{req.destroy();}catch(e){} resolve(null); });
    if(data) req.write(data); req.end();
  });
}
async function dockerNode(){                 // {found, running, id, proto} hoặc null (không có sock)
  const r = await sockReq('GET', '/containers/json?all=1');
  if(!r || r.status!==200) return null;
  let arr; try{ arr = JSON.parse(r.body); }catch(e){ return null; }
  const n = arr.find(c => (c.Names||[]).some(x=>/testnet/i.test(x)) || /pi-node-docker/i.test(c.Image||''));
  if(!n) return { found:false };
  const m = (n.Image||'').match(/p(\d+)\./);
  return { found:true, running:n.State==='running', id:n.Id, proto: m?('v'+m[1]):null };
}
async function dockerSync(id){               // 'synced'|'catching'|'down'|'unknown'
  try {
    const ex = await sockReq('POST', '/containers/'+id+'/exec',
      { AttachStdout:true, AttachStderr:true, Tty:true,
        Cmd:['sh','-c','stellar-core http-command info 2>/dev/null || curl -s localhost:11626/info 2>/dev/null || wget -qO- localhost:11626/info 2>/dev/null'] });
    if(!ex || ex.status>=400) return 'unknown';
    let id2; try{ id2 = JSON.parse(ex.body).Id; }catch(e){ return 'unknown'; }
    const out = await sockReq('POST', '/exec/'+id2+'/start', { Detach:false, Tty:true });
    const t = out ? (out.body||'') : '';
    if(/Synced!?/i.test(t)) return 'synced';
    if(/Catching up|catchup|Joining SCP|Booting/i.test(t)) return 'catching';
    if(/"state"/.test(t) || /"build"/.test(t)) return 'running-unknownsync';
    return 'unknown';
  } catch(e){ return 'unknown'; }
}

// ---------- cổng RA INTERNET: lấy từ server (đúng cái web dùng) ----------
function serverGet(pathname){
  return new Promise(function(res){
    const req = https.get({ host:SERVER, path:pathname, headers:{ 'User-Agent':'lacviet-agent' } },
      function(r){ let b=''; r.on('data',d=>b+=d); r.on('end',function(){ try{res(JSON.parse(b));}catch(e){res(null);} }); });
    req.on('error', function(){ res(null); }); req.setTimeout(9000, function(){ try{req.destroy();}catch(e){} res(null); });
  });
}
function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// ---- Prober TRUNG LẬP bên ngoài: check-host.net (dò TCP từ nhiều nước) ----
function chGet(pathname){
  return new Promise(function(res){
    const req = https.get({ host:'check-host.net', path:pathname, headers:{ 'Accept':'application/json', 'User-Agent':'lacviet-agent' } },
      function(r){ let b=''; r.on('data',d=>b+=d); r.on('end',function(){ try{res(JSON.parse(b));}catch(e){res(null);} }); });
    req.on('error', function(){ res(null); }); req.setTimeout(9000, function(){ try{req.destroy();}catch(e){} res(null); });
  });
}
async function chPort(ip, port){                    // true=mở, false=đóng, null=không kiểm được
  const st = await chGet('/check-tcp?host=' + ip + ':' + port + '&max_nodes=3');
  if(!st || !st.ok || !st.request_id) return null;
  for(let i=0;i<6;i++){
    await wait(1600);
    const r = await chGet('/check-result/' + st.request_id);
    if(!r) continue;
    let pending=false, anyDone=false, success=false;
    for(const k in r){
      const arr = r[k];
      if(arr==null){ pending=true; continue; }
      const it = Array.isArray(arr) ? arr[0] : arr;
      if(it==null){ pending=true; continue; }
      anyDone=true;
      if(it && typeof it==='object' && !it.error && (it.time!=null || it.address)) success=true;   // kết nối được
    }
    if(success) return true;
    if(anyDone && !pending) return false;
  }
  return null;
}
async function checkHostOpen(ip){                   // [ports mở] hoặc null nếu dịch vụ không dùng được
  const open=[]; let usable=false;
  for(const p of REQUIRED){ const r = await chPort(ip, p); if(r===null) continue; usable=true; if(r) open.push(p); }
  return usable ? open.sort(function(a,b){return a-b;}) : null;
}

// ---- Cache kết quả cổng ngoài (dò nền, không chặn /api/status) ----
let extCache = { state:'pending' };
let extBusy = false;
async function refreshExt(){
  if(extBusy) return; extBusy = true;
  try {
    if(!cfg.key){ extCache = { state:'pending' }; return; }
    const ip = cfg.ip || await pubIp();
    if(!ip){ extCache = { state:'unknown' }; return; }
    if(extCache.state !== 'ok') extCache = { state:'checking', ip:ip };
    // 1) Prober trung lập (đúng cho MỌI máy, kể cả cùng mạng máy chủ)
    const ind = await checkHostOpen(ip);
    if(ind !== null){ extCache = { state:'ok', open:ind, total:REQUIRED.length, ip:ip, src:'checkhost' }; return; }
    // 2) Dự phòng: server của mình (chỉ đúng khi node KHÁC mạng máy chủ)
    const j = await serverGet('/api/agent/portcheck?token=' + encodeURIComponent(cfg.key) + '&ip=' + encodeURIComponent(ip));
    if(j && !j.need_ip && j.open){ extCache = { state:'ok', open:j.open, total:j.total||REQUIRED.length, ip:ip, src:'server' }; return; }
    if(j && j.need_ip){ extCache = { state:'need_ip', ip:ip }; return; }
    extCache = { state:'unknown', ip:ip };
  } catch(e){ extCache = { state:'unknown' }; }
  finally { extBusy = false; }
}

// ---------- tổng hợp trạng thái ----------
async function status(){
  if(!cfg.key) return { linked:false, version:VERSION };
  const lo  = await localOpen();
  const ip  = cfg.ip || await pubIp(); if(ip){ cfg.ip=ip; saveCfg(cfg); }
  const dn  = await dockerNode();                  // null nếu không có docker.sock
  const ext = extCache;                            // dò nền, không chặn status

  // Node chạy? Ưu tiên docker.sock (thật). Không có sock -> suy từ cổng nội bộ (node listen).
  let docker, running, proto, sync;
  if(dn){
    docker  = dn.found ? (dn.running ? 'up' : 'down') : 'notfound';
    running = dn.found && dn.running;
    proto   = running ? (dn.proto || null) : null;
    sync    = running ? await dockerSync(dn.id) : 'down';
  } else {
    // không mount docker.sock: chỉ biết node có listen nội bộ hay không
    running = lo.length > 0;
    docker  = running ? 'up' : 'down';
    proto   = null;                                 // KHÔNG bịa
    sync    = running ? 'unknown' : 'down';         // không đo được -> không rõ
  }

  const r = hostRes();
  const info = await dockerInfo();
  const envType = info ? (info.isDesktop ? 'docker' : 'host') : 'docker';
  return {
    linked:true, code: cfg.code || '', version:VERSION,
    keyError: linkError,
    dockerAccess: !!dn,
    node: { docker, running, sync, proto, localOpen: lo, required: REQUIRED },
    ext, ip: ip || '',
    cpu:r.cpu, ram:r.ram, uptime:r.uptime,
    res: { cores: (info && info.ncpu) || r.cores, memGB: (info && info.memGB) || r.memGB, env: envType, envName: (info && info.os) || '' }
  };
}

// ---------- heartbeat về server ----------
function post(pathname, body){
  return new Promise(function(res, rej){
    const req=https.request({ host:SERVER, path:pathname, method:'POST',
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) } },
      function(r){ let b=''; r.on('data',d=>b+=d); r.on('end',function(){ let j={}; try{ j=JSON.parse(b);}catch(e){} res({ status:r.statusCode, body:j }); }); });
    req.on('error', rej); req.setTimeout(10000, function(){ try{req.destroy();}catch(e){} rej(new Error('timeout')); });
    req.write(body); req.end();
  });
}
let linkError = null;   // 'invalid_key' nếu server từ chối khóa (401/403)
async function heartbeat(){
  if(!cfg.key){ console.log('[hb] bo qua: chua co khoa (NODE_KEY)'); return; }
  try {
    console.log('[hb] bat dau gui...');
    const lo = await localOpen();
    const ip = await pubIp(); if(ip){ cfg.ip=ip; saveCfg(cfg); }
    const dn = await dockerNode();
    const running = dn ? (dn.found && dn.running) : (lo.length>0);
    const proto   = dn && dn.proto ? dn.proto : undefined;
    const body = JSON.stringify(Object.assign({
      token: cfg.key, machine_id: cfg.machineId, pi_state: running ? 'synced' : 'down',
      ports_open: lo.length, ports_total: REQUIRED.length, pub_ip: ip,
      agent_ver: 'solohost-'+VERSION, source:'solohost'
    }, proto ? { proto:proto } : {}));
    const r = await post('/api/agent/heartbeat', body);
    if(r.status===409){
      linkError = 'machine_conflict';
      console.log('[hb] TOKEN DA GAN MAY KHAC (409) — khoa nay dang dung o may khac. Tao lai ma neu chuyen may.');
    } else if(r.status===401 || r.status===403){
      linkError = 'invalid_key';
      console.log('[hb] KHOA KHONG HOP LE ('+r.status+') — token khong khop node nao. Kiem tra lai khoa lien ket.');
    } else if(r.status>=200 && r.status<300){
      linkError = null;
      console.log('[hb] OK -> '+SERVER+' | pi_state='+(running?'synced':'down')+' ports_local='+lo.length+' ip='+(ip||'?'));
      if(r.body && r.body.code){ cfg.code=r.body.code; saveCfg(cfg); }
    } else {
      console.log('[hb] server tra ma '+r.status);
    }
  } catch(e){ console.log('[hb] LOI gui heartbeat toi '+SERVER+': '+(e&&e.message)); }
}

// ---------- HTTP server ----------
const PUB = __dirname;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
const srv = http.createServer(async function(req, res){
  const u = (req.url||'/').split('?')[0];
  try {
    if(u==='/api/status'){ res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(await status())); }
    if(u==='/api/link' && req.method==='POST'){
      let b=''; req.on('data',d=>b+=d); req.on('end', async function(){
        try { const j=JSON.parse(b||'{}'); if(!j.key){ res.statusCode=400; return res.end('{"error":"missing key"}'); }
          cfg.key=String(j.key).trim(); if(j.server) cfg.server=j.server; saveCfg(cfg);
          await heartbeat(); refreshExt();
          res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ ok:true, code:cfg.code||'' }));
        } catch(e){ res.statusCode=500; res.end('{"error":"fail"}'); }
      });
      return;
    }
    if(u==='/api/unlink' && req.method==='POST'){ cfg={}; saveCfg(cfg); res.setHeader('Content-Type','application/json'); return res.end('{"ok":true}'); }
    if(u==='/healthz'){ return res.end('ok'); }
    let rel = u==='/' ? '/index.html' : u;
    let f = path.join(PUB, path.normalize(rel).replace(/^(\.\.[\/\\])+/,''));
    fs.readFile(f, function(e, data){
      if(e){ res.statusCode=404; return res.end('not found'); }
      res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(data);
    });
  } catch(e){ res.statusCode=500; res.end('error'); }
});
srv.listen(PORT, function(){ console.log('[lacviet-agent] v'+VERSION+' listening :'+PORT+' server='+SERVER+' nodeHost='+NODE_HOST); });
heartbeat(); setInterval(heartbeat, 60000);
refreshExt(); setInterval(refreshExt, 180000);     // dò cổng ngoài (nền) mỗi 3 phút
_cpuSampler();                                      // đo CPU% thật (nền)
