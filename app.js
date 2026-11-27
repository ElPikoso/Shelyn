'use strict';

const $=id=>document.getElementById(id), a=$('player');
const ST={
  IDLE:['Desconectado','grey'],
  CREATING:['Creando sala…','amber'],
  WAITING:['Esperando invitado…','amber'],
  APPROVAL:['Invitado pidiendo entrar','amber'],
  CONNECTING:['Conectando…','amber'],
  CONNECTED:['Conectado · audio en directo','green'],
  CONNECTED_SFU:['Conectado · sala grupal (SFU)','green'],
  RECONNECTING:['Reconectando…','amber'],
  FAILED:['Error de conexión','grey']
};
const LIVE=s=>s!=='IDLE'&&s!=='FAILED';
const pill=(el,s)=>{const [t,c]=ST[s]||ST.IDLE;el.textContent=t;el.className='pill '+c};
const toast=t=>{const el=$('toast');el.textContent=t;el.hidden=false;clearTimeout(el._t);el._t=setTimeout(()=>el.hidden=true,2600)};
const codeOk=()=>/^[1-9][0-9]{3}$/.test($('code').value.trim());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/* ---------- FIREBASE ANONYMOUS AUTH (JWT REAL) ---------- */
let authState={token:null,uid:null,exp:0,refresh:null},authBusy=null;
async function getAuth(){
  if(authState.token&&Date.now()<authState.exp)return authState;
  if(!authBusy)authBusy=renewAuth().finally(()=>{authBusy=null});
  return authBusy;
}
async function renewAuth(){
  // 1) Renovar con refresh token: conserva el MISMO uid (necesario para seguir siendo owner de la sala).
  //    Requiere "Token Service API" en las restricciones de la clave; si falla, se cae al paso 2.
  if(authState.refresh){
    try{
      const r=await fetch(`https://securetoken.googleapis.com/v1/token?key=${C.KEY}`,{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'grant_type=refresh_token&refresh_token='+encodeURIComponent(authState.refresh)
      });
      if(r.ok){
        const d=await r.json();
        authState={token:d.id_token,uid:d.user_id,refresh:d.refresh_token||authState.refresh,
          exp:Date.now()+(Number(d.expires_in||3600)-120)*1000};
        return authState;
      }
    }catch{}
  }
  // 2) Sesión anónima nueva
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${C.KEY}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({returnSecureToken:true})
  });
  if(!r.ok)throw new Error('Auth '+r.status);
  const d=await r.json();
  authState={token:d.idToken,uid:d.localId,refresh:d.refreshToken||null,
    exp:Date.now()+(Number(d.expiresIn||3600)-120)*1000};
  return authState;
}
const fbUrl=(p,tok)=>`${C.DB}/${p}.json?auth=${encodeURIComponent(tok)}`;

/* ---------- SERVIDORES ICE (STUN + TURN DESDE WORKER) ---------- */
let cachedIce=null;
async function getIceServers(){
  if(cachedIce)return cachedIce;
  const ice=[{urls:C.STUN}];
  if(C.SFU_PROXY){
    try{
      const r=await fetch(`${C.SFU_PROXY}/turn`,{method:'POST'});
      if(r.ok){
        const d=await r.json();
        // Cloudflare devuelve iceServers como OBJETO; el Worker puede devolver array. Aceptamos ambos.
        const list=[].concat(d.iceServers||[]).map(s=>({
          ...s,
          urls:[].concat(s.urls||[]).filter(u=>!/:53(\?|$)/.test(u)) // Chrome rechaza el puerto 53
        })).filter(s=>s.urls.length);
        if(list.length){
          ice.push(...list);
          cachedIce=ice;
        }
      }
    }catch{}
  }
  return ice;
}

/* ---------- CLIENTE CLOUDFLARE SFU VÍA WORKER ---------- */
async function sfuCall(path,method,body){
  const r=await fetch(`${C.SFU_PROXY}${path}`,{
    method,
    headers:{'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined
  });
  if(!r.ok)throw new Error('SFU '+r.status);
  return r.json();
}

/* ---------- SDP OPUS (96 kbps estéreo + FEC + ptime 10 / minptime 10 / maxptime 20) ----------
   ptime se coloca DESPUÉS de fmtp (dentro de la sección de medios, nunca entre m= y c=). */
function tuneOpus(sdp){
  const lines=sdp.split('\r\n');
  let pt=null;
  for(const l of lines){
    const m=l.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if(m){pt=m[1];break}
  }
  if(!pt)return sdp;
  const fmtp=`a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${C.BR}`;
  const ptime=`a=ptime:${C.PT}`,maxptime=`a=maxptime:${C.MAXPT}`;
  const base=lines.filter(l=>!l.startsWith('a=ptime:')&&!l.startsWith('a=maxptime:'));
  const out=[];
  let done=false;
  for(const l of base){
    if(l.startsWith('a=fmtp:'+pt+' ')){
      out.push(fmtp,ptime,maxptime);done=true;
    }else out.push(l);
  }
  if(!done){
    const idx=out.findIndex(l=>l.startsWith('a=rtpmap:'+pt+' '));
    if(idx>=0)out.splice(idx+1,0,fmtp,ptime,maxptime);
  }
  return out.join('\r\n');
}

/* ---------- PRIORIDAD DE RED DEL EMISOR (HOST) ---------- */
async function boostSender(pc){
  for(const s of pc.getSenders()){
    if(!s.track||s.track.kind!=='audio')continue;
    try{
      const p=s.getParameters();
      if(!p.encodings||!p.encodings.length)p.encodings=[{}];
      p.encodings[0].priority='high';
      p.encodings[0].networkPriority='high';
      await s.setParameters(p);
    }catch{}
  }
}

/* ---------- FIREBASE REST + SSE AUTENTICADO ---------- */
async function fbGet(p){const {token}=await getAuth();const r=await fetch(fbUrl(p,token));if(!r.ok)throw new Error('FB GET '+r.status);return r.json()}
async function fbPut(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB PUT '+r.status)}
async function fbPatch(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB PATCH '+r.status)}
async function fbPost(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB POST '+r.status)}
async function fbDel(p){try{const {token}=await getAuth();await fetch(fbUrl(p,token),{method:'DELETE'})}catch{}}
/* Escritura ATÓMICA "solo si está vacío" (igual que la app Android): el primero gana, el resto recibe 'conflict'.
   Si el navegador no deja enviar la cabecera if-match (CORS), se cae a leer + escribir + releer. */
async function fbPutIfEmpty(p,d){
  const {token}=await getAuth();
  try{
    const r=await fetch(fbUrl(p,token),{method:'PUT',headers:{'Content-Type':'application/json','if-match':'null_etag'},body:JSON.stringify(d)});
    if(r.ok)return 'ok';
    if(r.status===412)return 'conflict';
    throw new Error('FB PUT '+r.status);
  }catch(e){
    if(!(e instanceof TypeError))throw e;
    const cur=await fbGet(p).catch(()=>null);
    if(cur)return 'conflict';
    await fbPut(p,d);
    const chk=await fbGet(p).catch(()=>null);
    return chk&&chk.sdp===d.sdp?'ok':'conflict';
  }
}

/* ---------- GESTOR WEBRTC (P2P + SFU + MÓVIL INVITADO WEB) ---------- */
class Room{
  constructor(role,code,onState){
    this.role=role;this.code=code;this.onState=onState;
    this.pc=null;this.es=null;this.stream=null;this.dead=false;
    this.onTrack=null;this.onStats=null;this.onEnd=null;
    this.seen=new Set();this.timer=null;this.mode='p2p';this.sfuKey=null;
    this.myUid=null;
    this.answered=false;      // el host ya está gestionando una respuesta
    this.backlog=null;        // candidatos recibidos antes de tener remoteDescription
    this.pend=[];             // candidatos del host a publicar cuando la sala exista
    this.roomReady=false;
    this.connTimer=null;this.ticking=false;
    this.npEs=null;this.npTimer=null;this.npRetry=null;this.npRaw=null; // nowPlaying (invitado)
    // --- host multi-invitado ---
    this.gmap={};             // id -> {via,hb,seen,status:'new'|'queued'|'ok'}
    this.denied=new Set();    // invitados rechazados por el host
    this.queue=[];this.asking=false;
    this.p2pOk=false;         // el invitado P2P ya fue aceptado
    this.sfuPc=null;this.sfuActive=false;this.sfuBusy=false;this.sfuFailAt=0;
    // --- invitado ---
    this.claimed=false;       // ganó el hueco P2P (answer)
    this.waiting=false;       // en cola: espera a que el host abra la sala grupal
    this.claiming=false;
    this.gReady=false;this.pendG=[];this.mySdp=null;
    this.via='wait';this.hb=0;this.hbTimer=null;this.presenceOk=false;this.miss=0;
    this.waitTimer=null;this.sfuNext=0;
  }
  state(s){if(!this.dead)this.onState(s)}
  async mkPc(isSfu=false){
    const ice=await getIceServers();
    const pc=new RTCPeerConnection({iceServers:ice});
    const hostSfu=isSfu&&this.role==='host';
    // ¿sigue siendo esta la conexión vigente? (evita que una conexión cerrada/antigua tumbe la sala)
    const mine=()=>hostSfu?pc===this.sfuPc:pc===this.pc;
    if(!isSfu){
      pc.onicecandidate=e=>{
        if(e.candidate&&!this.dead){
          const payload={
            sdp:e.candidate.candidate,
            sdpMid:e.candidate.sdpMid||'',
            sdpMLineIndex:e.candidate.sdpMLineIndex??0
          };
          if(this.role==='host'){
            // Si la sala aún no existe, el fbPut la sobrescribiría: se guarda y se envía después.
            if(!this.roomReady){this.pend.push(payload);return}
            fbPost(`salas/${this.code}/hostCandidates`,payload).catch(()=>{});
          }else{
            // Solo el invitado que ganó el hueco P2P publica candidatos; el resto los descarta.
            if(!this.gReady){this.pendG.push(payload);return}
            fbPost(`salas/${this.code}/guestCandidates`,payload).catch(()=>{});
          }
        }
      };
    }
    pc.oniceconnectionstatechange=()=>{
      if(this.dead||!mine())return;
      const iceSt=pc.iceConnectionState;
      if(this.role==='guest'&&iceSt==='checking'){
        $('gStats').textContent='Negociando red (ICE/TURN)…';
      }else if(this.role==='guest'&&iceSt==='failed'){
        $('gStats').textContent='Bloqueo de red (NAT). Verifica TURN en Cloudflare Worker.';
      }
    };
    pc.onconnectionstatechange=()=>{
      if(this.dead||!mine())return;
      const st=pc.connectionState;
      const p2pHostInSfu=this.role==='host'&&!isSfu&&this.sfuActive; // el P2P ya no es imprescindible
      if(st==='connected'){
        clearTimeout(this.connTimer);
        if(this.role==='guest'){
          $('gStats').textContent=isSfu?'Modo grupal Cloudflare SFU':'Conexión directa P2P';
          if(isSfu)this.setVia('sfu');
        }
        this.state((isSfu||p2pHostInSfu)?'CONNECTED_SFU':'CONNECTED');
      }else if(st==='disconnected'){
        if(!p2pHostInSfu)this.state('RECONNECTING');
      }else if(st==='failed'||st==='closed'){
        if(p2pHostInSfu){try{pc.close()}catch{}if(this.pc===pc)this.pc=null}
        else this.end('IDLE');
      }
    };
    if(this.role==='guest'){
      pc.ontrack=e=>{if(this.onTrack)this.onTrack(e)};
    }
    if(hostSfu)this.sfuPc=pc;else this.pc=pc;
    return pc;
  }
  async listen(path,cb){
    const {token}=await getAuth();
    if(this.dead)return;
    const es=new EventSource(fbUrl(path,token));
    const handle=ev=>{
      if(this.dead)return;
      try{const d=JSON.parse(ev.data);if(d&&d.data!==undefined)cb(d.path,d.data)}catch{}
    };
    es.addEventListener('put',handle);
    es.addEventListener('patch',handle);
    es.onerror=()=>{if(!this.dead&&es.readyState===EventSource.CLOSED)this.end('FAILED')};
    this.es=es;
  }
  // Si aún no hay remoteDescription, los candidatos se guardan (sin marcarlos como vistos)
  async addCands(obj){
    if(!obj||!this.pc||this.mode==='sfu')return;
    if(!this.pc.remoteDescription){
      this.backlog={...(this.backlog||{}),...obj};
      return;
    }
    for(const [k,c] of Object.entries(obj)){
      if(this.seen.has(k)||!c||!c.sdp)continue;
      try{
        await this.pc.addIceCandidate({candidate:c.sdp,sdpMid:c.sdpMid,sdpMLineIndex:c.sdpMLineIndex});
        this.seen.add(k);
      }catch{}
    }
  }
  async flushBacklog(){
    const b=this.backlog;this.backlog=null;
    if(b)await this.addCands(b);
  }

  /* ================= HOST ================= */
  async hostStart(stream){
    this.stream=stream;
    stream.getAudioTracks()[0].onended=()=>this.end('IDLE');
    this.state('CREATING');
    const {uid}=await getAuth();
    const pc=await this.mkPc(false);
    stream.getAudioTracks().forEach(t=>pc.addTrack(t,stream));
    const off=await pc.createOffer();
    off.sdp=tuneOpus(off.sdp);
    await pc.setLocalDescription(off);
    await boostSender(pc);
    await fbPut(`salas/${this.code}`,{owner:uid,offer:{type:'offer',sdp:off.sdp}});
    // La sala ya existe: publicar los candidatos acumulados
    this.roomReady=true;
    for(const p of this.pend)fbPost(`salas/${this.code}/hostCandidates`,p).catch(()=>{});
    this.pend=[];
    this.state('WAITING');

    // Sondeo de respaldo (el SSE puede perder eventos): respuestas, candidatos y presencia de invitados
    this.timer=setInterval(()=>{this.hostTick().catch(()=>{})},2000);

    await this.listen(`salas/${this.code}`,(p,d)=>{
      try{
        if(p==='/'){
          if(d&&typeof d==='object')this.hostSnap(d);
        }else if(p==='/answer'){
          if(d&&d.sdp)this.hostSnap({answer:d,guests:undefined,_only:'answer'});
        }else if(p.startsWith('/guestCandidates')){
          fbGet(`salas/${this.code}/guestCandidates`).then(s=>this.addCands(s)).catch(()=>{});
        }else if(p.startsWith('/guests')){
          fbGet(`salas/${this.code}/guests`).then(s=>this.syncGuests(s)).catch(()=>{});
        }
      }catch{}
    });
  }
  async hostTick(){
    if(this.dead||this.ticking)return;
    this.ticking=true;
    try{
      const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
      if(!snap||this.dead)return;
      this.hostSnap(snap);
    }finally{this.ticking=false}
  }
  hostSnap(d){
    if(d.answer&&d.answer.sdp&&!this.answered&&this.pc){
      this.answered=true;
      this.enqueue({kind:'p2p',ans:d.answer});
    }
    if(d._only)return;
    if(d.guestCandidates)this.addCands(d.guestCandidates);
    this.syncGuests(d.guests);
  }
  // Presencia de invitados (guests/{id}: {hb,via}); mismo protocolo que la app Android
  syncGuests(obj){
    if(this.dead)return;
    const now=Date.now();
    const o=(obj&&typeof obj==='object')?obj:{};
    for(const id of Object.keys(this.gmap))if(!(id in o))delete this.gmap[id];
    for(const [id,g] of Object.entries(o)){
      if(!g||typeof g!=='object')continue;
      if(this.denied.has(id)){fbDel(`salas/${this.code}/guests/${id}`);continue}
      let e=this.gmap[id];
      if(!e)e=this.gmap[id]={status:'new',via:'wait',hb:null,seen:now};
      if(e.hb!==g.hb){e.hb=g.hb;e.seen=now}
      if(typeof g.via==='string')e.via=g.via;
    }
    for(const [id,e] of Object.entries(this.gmap)){
      if(now-e.seen>C.STALE_MS){delete this.gmap[id];fbDel(`salas/${this.code}/guests/${id}`)}
    }
    this.hostEvaluate();
  }
  hostEvaluate(){
    if(this.dead)return;
    let wantSfu=false;
    for(const [id,e] of Object.entries(this.gmap)){
      if(e.via==='p2p'){          // el invitado P2P se aprueba por su "answer"
        if(this.p2pOk)e.status='ok';
        continue;
      }
      if(e.status==='new'){e.status='queued';this.enqueue({kind:'g',id})}
      else if(e.status==='ok')wantSfu=true;
    }
    if(wantSfu&&!this.sfuActive&&!this.sfuBusy&&C.SFU_PROXY&&Date.now()>this.sfuFailAt)this.hostStartSfu();
    // Todos migraron al SFU: cerramos el P2P y limpiamos su señalización
    if(this.sfuActive&&this.pc&&!Object.values(this.gmap).some(e=>e.via==='p2p'))this.hostDropP2p();
    const n=Object.values(this.gmap).filter(e=>e.status==='ok').length;
    $('hStats').textContent=n?`${n} invitado${n>1?'s':''} escuchando`:'';
  }
  enqueue(it){this.queue.push(it);this.pump()}
  async pump(){
    if(this.asking||this.dead)return;
    this.asking=true;
    try{
      while(this.queue.length&&!this.dead){
        const it=this.queue.shift();
        try{
          if(it.kind==='p2p')await this.handleP2pAnswer(it.ans);
          else await this.handleWaiter(it.id);
        }catch{}
      }
    }finally{this.asking=false}
    this.restoreState();
  }
  restoreState(){
    if(this.dead)return;
    if(this.sfuActive)this.state('CONNECTED_SFU');
    else if(this.pc&&this.pc.connectionState==='connected')this.state('CONNECTED');
    else if(this.p2pOk)this.state('CONNECTING');
    else this.state('WAITING');
  }
  async handleP2pAnswer(ans){
    this.state('APPROVAL');
    const ok=await askModal();
    if(this.dead)return;
    if(!ok||!this.pc){
      await fbDel(`salas/${this.code}/answer`);
      await fbDel(`salas/${this.code}/guestCandidates`);
      this.backlog=null;
      this.answered=false;   // permitir que entre otro invitado
      return;
    }
    this.state('CONNECTING');
    try{
      await this.pc.setRemoteDescription({type:'answer',sdp:tuneOpus(ans.sdp)});
    }catch{
      this.answered=false;return;
    }
    this.p2pOk=true;
    await this.flushBacklog();
    const g=await fbGet(`salas/${this.code}/guestCandidates`).catch(()=>null);
    await this.addCands(g);
    this.hostEvaluate();
  }
  async handleWaiter(id){
    if(!this.gmap[id])return;
    this.state('APPROVAL');
    const ok=await askModal();
    if(this.dead)return;
    const e=this.gmap[id];
    if(!e)return;           // se fue mientras decidías
    if(ok){e.status='ok'}
    else{
      this.denied.add(id);delete this.gmap[id];
      await fbDel(`salas/${this.code}/guests/${id}`);
    }
    this.hostEvaluate();
  }
  // El host publica UNA pista en Cloudflare SFU y avisa por Firebase (nodo "sfu"); todos los invitados la escuchan
  async hostStartSfu(){
    if(this.sfuBusy||this.sfuActive||this.dead||!this
