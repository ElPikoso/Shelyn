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
    if(this.sfuBusy||this.sfuActive||this.dead||!this.stream)return;
    this.sfuBusy=true;
    try{
      const ses=await sfuCall('/sessions/new','POST');
      const pc=await this.mkPc(true);
      const trk=this.stream.getAudioTracks()[0];
      const tr=pc.addTransceiver(trk,{direction:'sendonly',streams:[this.stream]});
      const off=await pc.createOffer();
      off.sdp=tuneOpus(off.sdp);
      await pc.setLocalDescription(off);
      await boostSender(pc);
      const mid=tr.mid;
      const res=await sfuCall(`/sessions/${ses.sessionId}/tracks/new`,'POST',{
        sessionDescription:{type:'offer',sdp:off.sdp},
        tracks:[{location:'local',mid,trackName:C.SFU_TRACK}]
      });
      if(!res.sessionDescription||!res.sessionDescription.sdp)throw new Error('SFU sin respuesta');
      await pc.setRemoteDescription({type:'answer',sdp:res.sessionDescription.sdp});
      for(let i=0;i<60&&!this.dead&&pc.connectionState!=='connected';i++)await sleep(200);
      if(pc.connectionState!=='connected')throw new Error('SFU: ICE no conectó');
      await fbPut(`salas/${this.code}/sfu`,{sessionId:ses.sessionId,trackName:C.SFU_TRACK,mid,ts:Date.now()});
      this.sfuActive=true;
      this.state('CONNECTED_SFU');
      toast('Sala grupal activada');
    }catch(e){
      this.sfuFailAt=Date.now()+10000;
      const s=this.sfuPc;this.sfuPc=null;
      if(s){try{s.close()}catch{}}
      if(!this.dead)toast('No se pudo abrir la sala grupal');
    }finally{this.sfuBusy=false}
    this.hostEvaluate();
  }
  async hostDropP2p(){
    const pc=this.pc;
    if(!pc)return;
    this.pc=null;
    try{pc.close()}catch{}
    this.backlog=null;
    fbPatch(`salas/${this.code}`,{offer:null,answer:null,hostCandidates:null,guestCandidates:null}).catch(()=>{});
  }

  /* ================= INVITADO ================= */
  // nowPlaying del invitado: SSE propio (independiente de P2P/SFU) + sondeo lento de respaldo
  startNp(){
    const open=async()=>{
      if(this.dead)return;
      let token;
      try{({token}=await getAuth())}catch{this.npRetry=setTimeout(open,5000);return}
      if(this.dead)return;
      if(this.npEs)this.npEs.close();
      const es=new EventSource(fbUrl(`salas/${this.code}/nowPlaying`,token));
      this.npEs=es;
      const onData=ev=>{
        if(this.dead)return;
        try{
          const d=JSON.parse(ev.data);if(!d)return;
          const p=d.path||'/';
          if(p==='/'){
            this.npRaw=(ev.type==='patch'&&this.npRaw&&d.data&&typeof d.data==='object')?{...this.npRaw,...d.data}:d.data;
          }else{
            const k=p.split('/').filter(Boolean)[0];
            if(!this.npRaw||typeof this.npRaw!=='object')this.npRaw={};
            this.npRaw[k]=d.data;
          }
          applyNp(this.npRaw);
        }catch{}
      };
      es.addEventListener('put',onData);
      es.addEventListener('patch',onData);
      // Token caducado: reabrir con uno nuevo
      es.addEventListener('auth_revoked',()=>{es.close();if(!this.dead)this.npRetry=setTimeout(open,500)});
      es.onerror=()=>{if(!this.dead&&es.readyState===EventSource.CLOSED)this.npRetry=setTimeout(open,4000)};
    };
    open();
    this.npTimer=setInterval(()=>{
      if(this.dead)return;
      fbGet(`salas/${this.code}/nowPlaying`).then(v=>{if(!this.dead){this.npRaw=v;applyNp(v)}}).catch(()=>{});
    },20000);
  }
  armConn(ms){
    clearTimeout(this.connTimer);
    this.connTimer=setTimeout(()=>{
      if(this.dead||this.waiting)return;     // en cola manda waitTimer
      if(!this.pc||this.pc.connectionState!=='connected'){
        $('gStats').textContent='El anfitrión no respondió o la red bloquea la conexión.';
        this.end('FAILED');
      }
    },ms);
  }
  // Presencia: guests/{uid} = {hb,via}. via: 'p2p' | 'wait' | 'sfu'
  async writePresence(){
    if(this.dead||!this.myUid)return;
    try{
      await fbPut(`salas/${this.code}/guests/${this.myUid}`,{hb:++this.hb,via:this.via});
      this.presenceOk=true;
    }catch{}
  }
  startPresence(via){
    this.via=via;
    this.writePresence();
    if(!this.hbTimer)this.hbTimer=setInterval(()=>this.writePresence(),C.HB_MS);
  }
  setVia(v){this.via=v;this.writePresence()}
  // Si el host nos borra de guests/ (rechazo/expulsión), salimos
  async checkPresence(guests){
    if(!this.presenceOk||this.dead)return;
    let me;
    if(guests===undefined){
      try{me=await fbGet(`salas/${this.code}/guests/${this.myUid}`)}catch{return}
    }else me=guests?guests[this.myUid]:null;
    if(me){this.miss=0;return}
    if(++this.miss>=2){
      $('gStats').textContent='El anfitrión rechazó tu entrada.';
      this.end('FAILED');
    }
  }
  // Intenta quedarse con el hueco P2P (answer) de forma atómica. Si ya está ocupado, pasa a la cola del SFU.
  async tryJoinP2p(room){
    if(this.claiming||this.dead)return;
    this.claiming=true;
    try{
      if(this.pc){try{this.pc.close()}catch{}this.pc=null}
      this.mode='p2p';this.gReady=false;this.pendG=[];this.seen=new Set();this.backlog=null;
      const pc=await this.mkPc(false);
      pc.addTransceiver('audio',{direction:'recvonly'});
      await pc.setRemoteDescription({type:'offer',sdp:tuneOpus(room.offer.sdp)});
      const ans=await pc.createAnswer();
      ans.sdp=tuneOpus(ans.sdp);
      await pc.setLocalDescription(ans);
      const res=await fbPutIfEmpty(`salas/${this.code}/answer`,{type:'answer',sdp:ans.sdp});
      if(this.dead)return;
      if(res==='ok'){
        this.claimed=true;this.waiting=false;clearTimeout(this.waitTimer);
        this.mySdp=ans.sdp;
        this.startPresence('p2p');
        this.gReady=true;
        for(const c of this.pendG)fbPost(`salas/${this.code}/guestCandidates`,c).catch(()=>{});
        this.pendG=[];
        $('gStats').textContent='Esperando aceptación del anfitrión…';
        if(room.hostCandidates)await this.addCands(room.hostCandidates);
        this.armConn(C.CONN_MS);
      }else{
        try{pc.close()}catch{}
        if(this.pc===pc)this.pc=null;
        this.claimed=false;
        this.enterWait();
      }
    }finally{this.claiming=false}
  }
  enterWait(){
    this.waiting=true;
    this.startPresence('wait');
    this.state('CONNECTING');
    $('gStats').textContent='Hay otro invitado: esperando a que el anfitrión te acepte y abra la sala grupal…';
    clearTimeout(this.connTimer);clearTimeout(this.waitTimer);
    this.waitTimer=setTimeout(()=>{
      if(this.dead||this.mode==='sfu')return;
      $('gStats').textContent='El anfitrión no abrió la sala grupal (sala llena o sin aceptar).';
      this.end('FAILED');
    },C.WAIT_MS);
  }
  async demote(){   // otro invitado se quedó con el hueco P2P: pasamos a la cola
    if(this.pc){try{this.pc.close()}catch{}this.pc=null}
    this.claimed=false;this.gReady=false;this.pendG=[];
    this.enterWait();
  }
  async guestTick(){
    if(this.dead||this.ticking)return;
    this.ticking=true;
    try{
      if(this.pc&&this.pc.connectionState==='connected'){await this.checkPresence();return}
      const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
      if(!snap||this.dead)return;
      if(snap.nowPlaying)applyNp(snap.nowPlaying);
      if(snap.sfu&&snap.sfu.sessionId&&snap.sfu.trackName){
        await this.connectSfuGuest(snap.sfu);
        if(this.mode==='sfu')return;
      }
      if(this.mode==='p2p'){
        if(this.claimed){
          if(!snap.answer){$('gStats').textContent='El anfitrión rechazó tu entrada.';this.end('FAILED');return}
          if(snap.answer.sdp!==this.mySdp){await this.demote();return}
          if(snap.hostCandidates)await this.addCands(snap.hostCandidates);
        }else if(this.waiting&&!this.claiming&&snap.offer&&!snap.answer){
          await this.tryJoinP2p(snap);   // el hueco P2P se liberó: lo intentamos de nuevo
        }
      }
      await this.checkPresence(snap.guests||null);
    }finally{this.ticking=false}
  }
  async guestStart(){
    this.state('CONNECTING');
    $('gStats').textContent='Buscando sala…';
    this.armConn(C.CONN_MS);
    const {uid}=await getAuth();
    this.myUid=uid;
    this.startNp();
    const room=await fbGet(`salas/${this.code}`).catch(()=>null);
    if(!room||(!room.offer&&!room.sfu)){this.end('FAILED');return}
    if(room.nowPlaying)applyNp(room.nowPlaying);

    if(room.sfu&&room.sfu.sessionId&&room.sfu.trackName){
      await this.connectSfuGuest(room.sfu);
    }else{
      await this.tryJoinP2p(room);
    }

    this.timer=setInterval(()=>{this.guestTick().catch(()=>{})},1500);

    await this.listen(`salas/${this.code}`,async(p,d)=>{
      if(this.dead)return;
      try{
        if(p==='/'&&d){
          if(d.nowPlaying)applyNp(d.nowPlaying);
          if(d.sfu&&d.sfu.sessionId&&d.sfu.trackName){
            await this.connectSfuGuest(d.sfu);
            if(this.mode==='sfu')return;
          }
          if(this.claimed&&d.hostCandidates)await this.addCands(d.hostCandidates);
        }else if(p==='/nowPlaying'&&d&&typeof d==='object'){
          applyNp(d);
        }else if(p==='/sfu'&&d&&d.sessionId&&d.trackName){
          await this.connectSfuGuest(d);
        }else if(p.startsWith('/hostCandidates')&&this.mode==='p2p'&&this.claimed){
          if(p==='/hostCandidates')await this.addCands(d);
          else if(d)await this.addCands({[p.split('/').pop()]:d});
        }
      }catch{}
    });
  }
  async connectSfuGuest(sfu){
    const key=`${sfu.sessionId}:${sfu.trackName}`;
    if(this.sfuKey===key||Date.now()<this.sfuNext)return;
    this.sfuKey=key;
    this.mode='sfu';
    this.claimed=false;this.waiting=false;this.gReady=false;
    clearTimeout(this.waitTimer);
    if(!this.hbTimer)this.startPresence('wait');   // el host nos verá (y aprobará) por la presencia
    this.state('CONNECTING');
    $('gStats').textContent='Conectando por Cloudflare SFU…';
    this.armConn(C.CONN_MS/2);
    if(this.pc){try{this.pc.close()}catch{}this.pc=null}
    try{
      const ses=await sfuCall('/sessions/new','POST');
      const guestSessionId=ses.sessionId;
      const pc=await this.mkPc(true);
      pc.addTransceiver('audio',{direction:'recvonly'});

      const off=await pc.createOffer();
      off.sdp=tuneOpus(off.sdp);
      await pc.setLocalDescription(off);

      const trRes=await sfuCall(`/sessions/${guestSessionId}/tracks/new`,'POST',{
        sessionDescription:{type:'offer',sdp:off.sdp},
        tracks:[{
          location:'remote',
          sessionId:sfu.sessionId,
          trackName:sfu.trackName,
          mid:'0'
        }]
      });

      if(trRes.sessionDescription&&trRes.sessionDescription.sdp){
        await pc.setRemoteDescription({
          type:trRes.sessionDescription.type||'answer',
          sdp:tuneOpus(trRes.sessionDescription.sdp)
        });
      }
      if(trRes.requiresImmediateRenegotiation){
        const ans2=await pc.createAnswer();
        ans2.sdp=tuneOpus(ans2.sdp);
        await pc.setLocalDescription(ans2);
        await sfuCall(`/sessions/${guestSessionId}/renegotiate`,'PUT',{
          sessionDescription:{type:'answer',sdp:ans2.sdp}
        });
      }
    }catch(e){
      if(this.dead)return;
      this.sfuKey=null;this.sfuNext=Date.now()+4000;   // reintento en el próximo sondeo
      if(this.pc){try{this.pc.close()}catch{}this.pc=null}
      $('gStats').textContent='Error en la sala grupal, reintentando…';
    }
  }
  end(s='IDLE'){
    if(this.dead)return;
    this.dead=true;
    clearInterval(this.timer);
    clearInterval(this.hbTimer);
    clearTimeout(this.connTimer);clearTimeout(this.waitTimer);
    if(this.es)this.es.close();
    clearInterval(this.npTimer);clearTimeout(this.npRetry);
    if(this.npEs)this.npEs.close();
    if(this.pc)this.pc.close();
    if(this.sfuPc){try{this.sfuPc.close()}catch{}}
    if(this.stream)this.stream.getTracks().forEach(t=>t.stop());
    if(this.role==='host'){fbDel(`salas/${this.code}`);$('hStats').textContent=''}
    else if(this.myUid){
      fbDel(`salas/${this.code}/guests/${this.myUid}`);
      // Si éramos el invitado P2P y nos vamos, liberamos el hueco para el siguiente
      if(this.claimed&&this.mySdp)fbGet(`salas/${this.code}/answer`).then(an=>{if(an&&an.sdp===this.mySdp)fbDel(`salas/${this.code}/answer`)}).catch(()=>{});
    }
    this.onState(s);
    if(this.onEnd)this.onEnd();
  }
}

/* ---------- MODAL APROBACIÓN HOST ---------- */
function askModal(){
  return new Promise(res=>{
    const m=$('modal');m.hidden=false;
    const oldTitle=document.title;
    if(document.hidden)document.title='⚠ Invitado esperando · Shelyn';
    const done=v=>{clearTimeout(t);m.hidden=true;document.title=oldTitle;$('yes').onclick=$('no').onclick=null;res(v)};
    const t=setTimeout(()=>done(false),C.MODAL_MS);
    $('yes').onclick=()=>done(true);
    $('no').onclick=()=>done(false);
  });
}

/* ---------- NOW PLAYING (HOST) ---------- */
const NP={auto:true,timer:null};
// Quita contadores "(3) ", iconos y sufijos de web/navegador: " - YouTube Music", " - Spotify", " - Google Chrome"...
function npClean(raw){
  let s=String(raw||'').replace(/\s+/g,' ').trim();
  s=s.replace(/^\(\d+\)\s*/,'').replace(/^[▶⏵🔊🔇]\s*/u,'');
  const suf=/\s*[-–—|]\s*(YouTube Music|YouTube|Spotify(?:\s*[-–—]\s*Web Player)?|Google Chrome|Brave|Microsoft Edge|Mozilla Firefox|Firefox|Opera|SoundCloud|Deezer|Apple Music|Tidal|Amazon Music)\s*$/i;
  let prev;
  do{prev=s;s=s.replace(suf,'').trim()}while(s!==prev);
  return s;
}
// Spotify web pone "Canción • Artista" en el título de la pestaña
function npSplit(s){
  const m=s.match(/^(.+?)\s[•·]\s(.+)$/);
  return m?{title:m[1].trim(),artist:m[2].trim()}:{title:s,artist:''};
}
// Etiquetas técnicas (ids de captura) que no sirven como título
const npTech=l=>!l||/^(web-contents-media-stream|screen:|window:|monitor|tab:|\w+:\d+:\d+)|:\/\//i.test(l)||/^(system audio|tab audio|audio de la pestaña|audio del sistema)$/i.test(l.trim());
function npGuess(labels){
  for(const l of labels){
    if(npTech(l))continue;
    const s=npClean(l);
    if(s)return npSplit(s);
  }
  return {title:'',artist:''};
}
const npRead=()=>({title:$('npTitle').value.trim().slice(0,149),artist:$('npArtist').value.trim().slice(0,149)});
async function npPublish(){
  const r=hostRoom;
  if(!r||r.dead||!r.roomReady)return;
  const {title,artist}=npRead();
  try{
    if(!title){await fbDel(`salas/${r.code}/nowPlaying`);return}
    await fbPut(`salas/${r.code}/nowPlaying`,{title,artist,updatedAt:Date.now()});
  }catch{}
}
['npTitle','npArtist'].forEach(id=>$(id).addEventListener('input',()=>{
  NP.auto=false;
  clearTimeout(NP.timer);
  NP.timer=setTimeout(npPublish,600);
}));

/* ---------- UI ---------- */
let hostRoom=null,guestRoom=null,rxr=null;
const setJb=()=>{
  if(!rxr)return;
  const ms=document.hidden?C.JBH:C.JB;
  try{rxr.jitterBufferTarget=ms}catch{}
  try{rxr.playoutDelayHint=ms/1000}catch{}
};
document.addEventListener('visibilitychange',setJb);

const tab=h=>{$('tG').classList.toggle('on',!h);$('tH').classList.toggle('on',h);$('pG').hidden=h;$('pH').hidden=!h};
$('tG').onclick=()=>tab(false);$('tH').onclick=()=>tab(true);

function silentWav(){
  const b=new ArrayBuffer(1644),d=new DataView(b),w=(o,s)=>{for(let i=0;i<s.length;i++)d.setUint8(o+i,s.charCodeAt(i))};
  w(0,'RIFF');d.setUint32(4,1636,true);w(8,'WAVEfmt ');d.setUint32(16,16,true);d.setUint16(20,1,true);d.setUint16(22,1,true);
  d.setUint32(24,8000,true);d.setUint32(28,16000,true);d.setUint16(32,2,true);d.setUint16(34,16,true);w(36,'data');d.setUint32(40,1600,true);
  return URL.createObjectURL(new Blob([b],{type:'audio/wav'}));
}

/* ---------- NOW PLAYING (INVITADO): estado, tarjeta y Media Session ---------- */
let npCur=null,npVisible=false,mediaOn=false,npDefArt=null;
const npUrl=u=>typeof u==='string'&&u.length<=500&&/^https?:\/\//i.test(u)?u:'';
const npTxt=v=>String(v==null?'':v).replace(/\s+/g,' ').trim().slice(0,149);
function npNorm(raw){
  if(!raw||typeof raw!=='object')return null;
  const title=npTxt(raw.title);
  if(!title)return null;
  return {title,artist:npTxt(raw.artist),artwork:npUrl(raw.artwork),updatedAt:Number(raw.updatedAt)||0};
}
function applyNp(raw){
  const n=npNorm(raw);
  if(n&&npCur&&n.updatedAt&&npCur.updatedAt&&n.updatedAt<npCur.updatedAt)return; // dato antiguo (sondeo tardío)
  if(JSON.stringify(n)===JSON.stringify(npCur))return;
  npCur=n;renderNp();if(mediaOn)mediaMeta();
}
function renderNp(){
  const c=$('npCard'),n=npCur,img=$('npImg');
  c.hidden=!npVisible;
  $('npT').textContent=n?n.title:'Audio en directo';
  $('npA').textContent=n?(n.artist||'Audio en directo'):'Sin título de pista';
  if(n&&n.artwork){
    if(img.dataset.src!==n.artwork){img.dataset.src=n.artwork;img.hidden=true;img.src=n.artwork}
  }else{
    delete img.dataset.src;img.hidden=true;img.removeAttribute('src');
  }
}
function npReset(){npCur=null;npVisible=false;renderNp()}
// Carátula por defecto (PNG 512 generado con canvas) para la pantalla de bloqueo
function defArt(){
  if(npDefArt)return npDefArt;
  try{
    const c=document.createElement('canvas');c.width=c.height=512;
    const x=c.getContext('2d'),g=x.createLinearGradient(0,0,512,512);
    g.addColorStop(0,'#6366f1');g.addColorStop(1,'#a855f7');
    x.fillStyle=g;x.fillRect(0,0,512,512);
    x.fillStyle='#fff';
    [140,260,200,300,170].forEach((h,i)=>x.fillRect(92+i*68,256-h/2,40,h));
    npDefArt=[{src:c.toDataURL('image/png'),sizes:'512x512',type:'image/png'}];
  }catch{npDefArt=[]}
  return npDefArt;
}
function mediaMeta(){
  const m=navigator.mediaSession;if(!m||typeof MediaMetadata==='undefined')return;
  try{
    const n=npCur;
    m.metadata=new MediaMetadata({
      title:n?n.title:'Shelyn · Audio en directo',
      artist:n?(n.artist||'Audio en directo'):'Escuchando en directo',
      album:'Shelyn',
      artwork:n&&n.artwork?[{src:n.artwork,sizes:'512x512'}]:defArt()
    });
  }catch{}
}

function media(on){
  mediaOn=!!on;
  const m=navigator.mediaSession;if(!m)return;
  try{
    if(on){
      mediaMeta();
      m.playbackState='playing';
      m.setActionHandler('stop',()=>guestRoom&&guestRoom.end('IDLE'));
    }else{
      m.playbackState='none';m.metadata=null;m.setActionHandler('stop',null);
    }
  }catch{}
}

const play=()=>a.play().then(()=>$('tap').hidden=true).catch(()=>$('tap').hidden=false);
$('tap').onclick=play;

function guestUi(s){
  pill($('gPill'),s);const live=LIVE(s);
  $('joinBtn').textContent=live?'Desconectar':'Unirse a la sala';
  $('joinBtn').className='btn'+(live?' stop':'');
  $('joinBtn').disabled=!live&&!codeOk();
  $('code').disabled=live;
  if(live){
    npVisible=(s==='CONNECTED'||s==='CONNECTED_SFU'||s==='RECONNECTING');
    renderNp();$('npCard').classList.toggle('paused',s==='RECONNECTING');
  }else{
    npReset();
    rxr=null;media(false);$('tap').hidden=true;a.srcObject=null;
    if(s==='FAILED'&&!$('gStats').textContent.startsWith('El anfitrión'))
      $('gStats').textContent='No se pudo contactar con el servidor o la sala no existe.';
  }
}

$('code').oninput=()=>{$('joinBtn').disabled=!codeOk()};
$('joinBtn').onclick=()=>{
  if(guestRoom){guestRoom.end('IDLE');return}
  if(!codeOk())return;
  $('gStats').textContent='';
  a.src=silentWav();a.play().catch(()=>{});
  const r=guestRoom=new Room('guest',+$('code').value.trim(),guestUi);
  r.onTrack=e=>{rxr=e.receiver;setJb();a.srcObject=e.streams[0]||new MediaStream([e.track]);media(true);play()};
  r.onEnd=()=>{guestRoom=null};
  r.guestStart().catch(()=>r.end('FAILED'));
};

/* ---------- CONTROLES HOST ---------- */
function hostUi(s){
  pill($('hPill'),s);const live=LIVE(s);
  $('hostBtn').textContent=live?'Detener transmisión':'Elegir pestaña y crear sala';
  $('hostBtn').className='btn'+(live?' stop':'');
  $('shareBtn').hidden=!live;
  if(!live){$('hCode').textContent='– – – –';$('hCode').className='code off'}
}

$('shareBtn').onclick=async()=>{
  if(!hostRoom)return;
  const url=`${C.BASE}?sala=${hostRoom.code}`;
  if(navigator.share)try{await navigator.share({title:'Shelyn',text:'Escucha mi audio en directo',url});return}catch{}
  await navigator.clipboard.writeText(url);toast('Enlace copiado');
};

$('hostBtn').onclick=async()=>{
  if(hostRoom){hostRoom.end('IDLE');return}
  $('hWarn').textContent='';
  let stream;
  try{
    stream=await navigator.mediaDevices.getDisplayMedia({
      video:true,
      audio:{
        channelCount:2,
        sampleRate:48000,
        latency:0.01,
        echoCancellation:false,
        noiseSuppression:false,
        autoGainControl:false
      }
    });
  }catch{
    $('hWarn').textContent='Permiso cancelado o navegador no compatible.';
    return;
  }
  const npLabels=[...stream.getVideoTracks(),...stream.getAudioTracks()].map(t=>t.label);
  stream.getVideoTracks().forEach(t=>t.stop());
  if(!stream.getAudioTracks().length){
    $('hWarn').textContent='No marcaste "Compartir audio de la pestaña".';
    return;
  }
  stream.getAudioTracks().forEach(t=>{try{t.contentHint='music'}catch{}});
  if(NP.auto||!$('npTitle').value.trim()){
    const g=npGuess(npLabels);
    if(g.title){$('npTitle').value=g.title;$('npArtist').value=g.artist;NP.auto=true}
  }
  const code=Math.floor(1000+Math.random()*9000);
  $('hCode').textContent=code;$('hCode').className='code';
  const r=hostRoom=new Room('host',code,hostUi);
  r.onEnd=()=>{hostRoom=null};
  try{
    await r.hostStart(stream);
    npPublish();
  }catch(e){
    $('hWarn').textContent='Error al crear la sala ('+(e&&e.message?e.message:'Firebase')+').';
    r.end('IDLE');
  }
};

// Carátula: mostrar solo si carga; si falla, queda el icono
$('npImg').onload=()=>{$('npImg').hidden=false};
$('npImg').onerror=()=>{$('npImg').hidden=true};

// Auto-rellenar código desde ?sala=1234
const q=new URLSearchParams(location.search).get('sala');
if(q&&/^[1-9][0-9]{3}$/.test(q)){$('code').value=q;$('joinBtn').disabled=false}
