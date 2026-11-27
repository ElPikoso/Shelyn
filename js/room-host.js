'use strict';
/* Room: métodos del anfitrión + modal de aprobación */

Object.assign(Room.prototype,{
  /* ================= HOST ================= */
  async hostStart(stream){
    this.stream=stream;
    this.restore();
    stream.getAudioTracks()[0].onended=()=>this.end('IDLE');
    this.state('CREATING');
    const {uid}=await getAuth();
    const pc=await this.mkPc(false);
    stream.getAudioTracks().forEach(t=>pc.addTrack(t,stream));
    const off=await pc.createOffer();
    off.sdp=tuneOpus(off.sdp);
    await pc.setLocalDescription(off);
    await boostSender(pc);
    await fbPut(`salas/${this.code}`,{owner:uid,hostName:nickName($('hNick').value),gen:Date.now()+'-'+Math.random().toString(36).slice(2,6),hb:{'.sv':'timestamp'},offer:{type:'offer',sdp:off.sdp}});
    // La sala ya existe: publicar los candidatos acumulados
    this.roomReady=true;
    for(const p of this.pend)fbPost(`salas/${this.code}/hostCandidates`,p).catch(()=>{});
    this.pend=[];
    this.state('WAITING');
    // Latido del host: permite detectar y limpiar salas colgadas (pestaña cerrada sin desconectar)
    this.hbTimer=setInterval(()=>this.hostBeat(),C.HOST_HB_MS);

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
  },
  // Invitados aceptados y expulsados sobreviven a una recarga del host (misma pestaña y mismo código):
  // al volver, los que ya estaban dentro entran sin pedir permiso otra vez y los expulsados siguen fuera.
  restore(){
    try{
      const s=JSON.parse(sessionStorage.getItem('shelyn_hs_'+this.code)||'null');
      if(s){this.trusted=new Set(s.t||[]);this.denied=new Set(s.d||[])}
    }catch{}
  },
  persist(){
    try{sessionStorage.setItem('shelyn_hs_'+this.code,JSON.stringify({t:[...this.trusted],d:[...this.denied]}))}catch{}
  },
  hostBeat(){
    if(this.dead||!this.roomReady)return;
    fbPut(`salas/${this.code}/hb`,{'.sv':'timestamp'}).catch(()=>{});
  },
  async hostTick(){
    if(this.dead||this.ticking)return;
    this.ticking=true;
    try{
      const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
      if(!snap||this.dead)return;
      this.hostSnap(snap);
    }finally{this.ticking=false}
  },
  hostSnap(d){
    if(d.answer&&d.answer.sdp&&!this.answered&&this.pc){
      if(this.denied.has(d.answer.by))fbDel(`salas/${this.code}/answer`);   // expulsado
      else{
        this.answered=true;
        this.enqueue({kind:'p2p',ans:d.answer});
      }
    }
    if(d._only)return;
    if(d.guestCandidates)this.addCands(d.guestCandidates);
    this.syncGuests(d.guests);
  },
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
      if(!e)e=this.gmap[id]={status:this.trusted.has(id)?'ok':'new',via:'wait',hb:null,seen:now};
      if(e.hb!==g.hb){e.hb=g.hb;e.seen=now}
      if(typeof g.via==='string')e.via=g.via;
      e.name=nickName(g.name);
    }
    for(const [id,e] of Object.entries(this.gmap)){
      if(now-e.seen>C.STALE_MS){delete this.gmap[id];fbDel(`salas/${this.code}/guests/${id}`)}
    }
    this.hostEvaluate();
  },
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
    for(const [id,e] of Object.entries(this.gmap))if(e.status==='ok')this.trusted.add(id);
    this.persist();
    showPeople('hPeople',Object.entries(this.gmap)
      .map(([id,e])=>({id,label:(e.name||'Invitado')+(e.status==='ok'?'':' · pendiente')}))
      .sort((x,y)=>x.label.localeCompare(y.label)),id=>this.kick(id));
    const n=Object.values(this.gmap).filter(e=>e.status==='ok').length;
    $('hStats').textContent=n?`${n} invitado${n>1?'s':''} escuchando`:'';
  },
  enqueue(it){this.queue.push(it);this.pump()},
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
  },
  restoreState(){
    if(this.dead)return;
    if(this.sfuActive)this.state('CONNECTED_SFU');
    else if(this.pc&&this.pc.connectionState==='connected')this.state('CONNECTED');
    else if(this.p2pOk)this.state('CONNECTING');
    else this.state('WAITING');
  },
  async handleP2pAnswer(ans){
    this.state('APPROVAL');
    const who=ans.by?await fbGet(`salas/${this.code}/guests/${ans.by}/name`).catch(()=>null):null;
    const ok=(ans.by&&this.trusted.has(ans.by))?true:await askModal(who);
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
  },
  async handleWaiter(id){
    if(!this.gmap[id])return;
    this.state('APPROVAL');
    const ok=await askModal(this.gmap[id].name);
    if(this.dead)return;
    const e=this.gmap[id];
    if(!e)return;           // se fue mientras decidías
    if(ok){e.status='ok'}
    else{
      this.denied.add(id);this.trusted.delete(id);delete this.gmap[id];
      await fbDel(`salas/${this.code}/guests/${id}`);
    }
    this.hostEvaluate();
  },
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
  },
  // Expulsa a un invitado; no puede volver a entrar en esta sala
  async kick(id){
    const e=this.gmap[id];
    if(!e||this.dead)return;
    this.denied.add(id);this.trusted.delete(id);delete this.gmap[id];
    // Ocupaba la conexión directa y no hay sala grupal: se corta y se ofrece una nueva
    if(e.via==='p2p'&&!this.sfuActive){
      try{await this.hostRearm()}catch{this.end('FAILED');return}
    }
    await fbDel(`salas/${this.code}/guests/${id}`);
    this.hostEvaluate();
  },
  async hostRearm(){
    const old=this.pc;this.pc=null;
    if(old)old.close();
    this.answered=true;                       // ignora la answer antigua hasta publicar la oferta nueva
    this.p2pOk=false;this.backlog=null;this.seen=new Set();this.roomReady=false;this.pend=[];
    const pc=await this.mkPc(false);
    this.stream.getAudioTracks().forEach(t=>pc.addTrack(t,this.stream));
    const off=await pc.createOffer();
    off.sdp=tuneOpus(off.sdp);
    await pc.setLocalDescription(off);
    await boostSender(pc);
    await fbPatch(`salas/${this.code}`,{offer:{type:'offer',sdp:off.sdp},answer:null,hostCandidates:null,guestCandidates:null});
    this.roomReady=true;this.answered=false;
    for(const p of this.pend)fbPost(`salas/${this.code}/hostCandidates`,p).catch(()=>{});
    this.pend=[];
    this.state('WAITING');
  },
  async hostDropP2p(){
    const pc=this.pc;
    if(!pc)return;
    this.pc=null;
    try{pc.close()}catch{}
    this.backlog=null;
    fbPatch(`salas/${this.code}`,{offer:null,answer:null,hostCandidates:null,guestCandidates:null}).catch(()=>{});
  },
});

/* ---------- MODAL APROBACIÓN HOST ---------- */
function askModal(name){
  return new Promise(res=>{
    const m=$('modal');m.hidden=false;
    m.querySelector('h2').textContent=`${nickName(name)||'Un invitado'} quiere unirse`;
    const oldTitle=document.title;
    if(document.hidden)document.title='⚠ Invitado esperando · Shelyn';
    const done=v=>{clearTimeout(t);m.hidden=true;document.title=oldTitle;$('yes').onclick=$('no').onclick=null;res(v)};
    const t=setTimeout(()=>done(false),C.MODAL_MS);
    $('yes').onclick=()=>done(true);
    $('no').onclick=()=>done(false);
  });
}
