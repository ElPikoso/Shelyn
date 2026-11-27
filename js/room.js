'use strict';
/* Clase Room (núcleo): constructor, mkPc, listen, candidatos y end(). Host e invitado se añaden en room-host.js y room-guest.js */

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
    this.roomSeen=false;this.gen=null;this.lastHb=0;this.hbSeen=false;this.watchTimer=null;this.watching=false;
    this.pcLostAt=0;this.away=false;this.rejoining=false;
    this.esRetry=null;this.npEs=null;this.npTimer=null;this.npRetry=null;this.npRaw=null; // nowPlaying (invitado)
    // --- host multi-invitado ---
    this.gmap={};             // id -> {via,hb,seen,status:'new'|'queued'|'ok'}
    this.denied=new Set();this.trusted=new Set();    // invitados rechazados por el host
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
        else if(this.role==='guest'&&this.roomSeen&&!this.dead)this.audioLost(pc);   // el host puede volver: no cerramos
        else this.end('IDLE');
      }
    };
    if(this.role==='guest'){
      pc.ontrack=e=>{if(this.onTrack)this.onTrack(e)};
    }
    if(hostSfu)this.sfuPc=pc;else this.pc=pc;
    return pc;
  }
  // SSE reconectable: si el token caduca (auth_revoked) o se corta la conexión, se reabre con un token nuevo
  async listen(path,cb){
    let fails=0;
    const open=async()=>{
      if(this.dead)return;
      let token;
      try{({token}=await getAuth())}catch{
        if(++fails>6){this.end('FAILED');return}
        this.esRetry=setTimeout(open,2000);return;
      }
      if(this.dead)return;
      if(this.es)this.es.close();
      const es=new EventSource(fbUrl(path,token));
      this.es=es;
      const handle=ev=>{
        if(this.dead)return;
        fails=0;
        try{const d=JSON.parse(ev.data);if(d&&d.data!==undefined)cb(d.path,d.data)}catch{}
      };
      es.addEventListener('put',handle);
      es.addEventListener('patch',handle);
      es.addEventListener('auth_revoked',()=>{es.close();if(!this.dead)this.esRetry=setTimeout(open,300)});
      es.onerror=()=>{
        if(this.dead||es.readyState!==EventSource.CLOSED)return;
        if(++fails>6)this.end('FAILED');
        else this.esRetry=setTimeout(open,2000);
      };
    };
    await open();
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
  end(s='IDLE'){
    if(this.dead)return;
    this.dead=true;
    clearInterval(this.timer);
    clearInterval(this.hbTimer);
    clearTimeout(this.connTimer);clearTimeout(this.waitTimer);clearTimeout(this.esRetry);clearInterval(this.watchTimer);
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
