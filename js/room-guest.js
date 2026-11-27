'use strict';
/* Room: métodos del invitado */

Object.assign(Room.prototype,{
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
  },
  // La conexión de audio cayó pero la sala sigue: se espera al host en vez de cerrar
  audioLost(pc){
    if(this.dead)return;
    try{pc.close()}catch{}
    if(this.pc===pc)this.pc=null;
    this.pcLostAt=Date.now();
    this.state('RECONNECTING');
    $('gStats').textContent='Conexión de audio perdida. Reintentando…';
  },
  // Vigilante del host: sin latido => "desconectado" y cuenta atrás; pasado el plazo, la sala se cierra sola
  async watch(){
    if(this.dead||!this.roomSeen||!this.hbSeen||this.watching||this.rejoining)return;
    this.watching=true;
    try{
      const now=Date.now(),silent=now-this.lastHb;
      if(silent>=C.HOST_GRACE_MS){
        $('gStats').textContent='El anfitrión no volvió: sala cerrada.';
        fbDel(`salas/${this.code}`);   // solo surte efecto si las reglas permiten limpiar salas caducadas
        this.end('FAILED');return;
      }
      if(silent>=C.HOST_LOST_MS){
        if(!this.away){this.away=true;this.state('RECONNECTING')}
        $('gStats').textContent=`Anfitrión desconectado. Esperando a que vuelva… (${Math.ceil((C.HOST_GRACE_MS-silent)/1000)} s)`;
        // por si se perdió el aviso de sala nueva
        const g=await fbGet(`salas/${this.code}/gen`).catch(()=>null);
        if(g&&this.gen&&g!==this.gen&&!this.dead){
          const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
          if(snap&&snap.gen===g)await this.rejoin(snap);
        }
        return;
      }
      if(this.away){
        this.away=false;
        if(this.pc&&this.pc.connectionState==='connected')this.state(this.mode==='sfu'?'CONNECTED_SFU':'CONNECTED');
      }
      if(this.pcLostAt&&now-this.pcLostAt>3000){
        if(this.mode==='sfu'){          // el host sigue ahí: pedir de nuevo la pista
          this.pcLostAt=0;this.sfuKey=null;this.sfuNext=0;
          const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
          if(snap&&snap.sfu&&snap.sfu.sessionId)await this.connectSfuGuest(snap.sfu);
        }else if(now-this.pcLostAt>20000){   // P2P caído con el host vivo: no se puede recuperar solo
          $('gStats').textContent='Se perdió la conexión directa con el anfitrión.';
          this.end('FAILED');
        }
      }
    }finally{this.watching=false}
  },
  // El host volvió con una sala nueva (otro "gen"): volver a conectar desde cero
  async rejoin(room){
    if(this.dead||this.rejoining)return;
    this.rejoining=true;
    try{
      this.gen=room.gen;this.lastHb=Date.now();this.hbSeen=!!room.hb;this.away=false;this.pcLostAt=0;
      if(this.pc){try{this.pc.close()}catch{}this.pc=null}
      this.sfuKey=null;this.sfuArmed=false;this.sfuNext=0;
      this.claimed=false;this.waiting=false;this.gReady=false;this.pendG=[];this.mySdp=null;
      this.seen=new Set();this.backlog=null;this.mode='p2p';
      this.state('CONNECTING');
      $('gStats').textContent='El anfitrión ha vuelto. Reconectando…';
      this.armConn(C.CONN_MS);
      this.writePresence();
      if(room.sfu&&room.sfu.sessionId&&room.sfu.trackName)await this.connectSfuGuest(room.sfu);
      else if(room.offer)await this.tryJoinP2p(room);
    }finally{this.rejoining=false}
  },
  armConn(ms){
    clearTimeout(this.connTimer);
    this.connTimer=setTimeout(()=>{
      if(this.dead||this.waiting)return;     // en cola manda waitTimer
      if(!this.pc||this.pc.connectionState!=='connected'){
        $('gStats').textContent='El anfitrión no respondió o la red bloquea la conexión.';
        this.end('FAILED');
      }
    },ms);
  },
  // Presencia: guests/{uid} = {hb,via}. via: 'p2p' | 'wait' | 'sfu'
  async writePresence(){
    if(this.dead||!this.myUid)return;
    try{
      await fbPut(`salas/${this.code}/guests/${this.myUid}`,{hb:++this.hb,via:this.via,name:nickName($('nick').value)});
      this.presenceOk=true;
    }catch{}
  },
  startPresence(via){
    this.via=via;
    this.writePresence();
    if(!this.hbTimer)this.hbTimer=setInterval(()=>this.writePresence(),C.HB_MS);
  },
  setVia(v){this.via=v;this.writePresence()},
  // Si el host nos borra de guests/ (rechazo/expulsión), salimos
  async checkPresence(guests){
    if(!this.presenceOk||this.dead||this.rejoining||this.away)return;
    if(guests===undefined){
      try{guests=await fbGet(`salas/${this.code}/guests`)}catch{return}
      if(this.dead)return;
    }
    showPeople('gPeople',Object.entries(guests||{}).map(([id,g])=>
      (nickName(g&&g.name)||'Invitado')+(id===this.myUid?' (tú)':'')+(g&&g.via==='wait'?' · en espera':'')).sort());
    const me=guests?guests[this.myUid]:null;
    if(me){this.miss=0;return}
    if(++this.miss>=2){
      // ¿el host volvió con una sala nueva? (la presencia se borró al recrearla): reconectar, no expulsar
      const g=await fbGet(`salas/${this.code}/gen`).catch(()=>null);
      if(g&&this.gen&&g!==this.gen){
        this.miss=0;
        const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
        if(snap&&!this.dead)await this.rejoin(snap);
        return;
      }
      $('gStats').textContent='El anfitrión rechazó tu entrada.';
      this.end('FAILED');
    }
  },
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
      const res=await fbPutIfEmpty(`salas/${this.code}/answer`,{type:'answer',sdp:ans.sdp,by:this.myUid});
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
  },
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
  },
  async demote(){   // otro invitado se quedó con el hueco P2P: pasamos a la cola
    if(this.pc){try{this.pc.close()}catch{}this.pc=null}
    this.claimed=false;this.gReady=false;this.pendG=[];
    this.enterWait();
  },
  async guestTick(){
    if(this.dead||this.ticking)return;
    this.ticking=true;
    try{
      if(this.pc&&this.pc.connectionState==='connected'){await this.checkPresence();return}
      const snap=await fbGet(`salas/${this.code}`).catch(()=>null);
      if(!snap||this.dead)return;
      if(snap.gen&&this.gen&&snap.gen!==this.gen){await this.rejoin(snap);return}
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
  },
  async guestStart(){
    this.state('CONNECTING');
    $('gStats').textContent='Buscando sala…';
    this.armConn(C.CONN_MS);
    const {uid}=await getAuth();
    this.myUid=uid;
    this.startNp();
    const room=await fbGet(`salas/${this.code}`).catch(()=>null);
    if(!room||(!room.offer&&!room.sfu)){this.end('FAILED');return}
    if(room.hb&&Date.now()-room.hb>C.ROOM_STALE_MS){
      $('gStats').textContent='El anfitrión no está activo (sala caducada).';
      this.end('FAILED');return;
    }
    this.roomSeen=true;this.gen=room.gen||null;this.hbSeen=!!room.hb;this.lastHb=Date.now();
    this.watchTimer=setInterval(()=>this.watch().catch(()=>{}),3000);
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
          if(d.hb){this.lastHb=Date.now();this.hbSeen=true}
          if(d.gen&&this.gen&&d.gen!==this.gen){await this.rejoin(d);return}   // el host volvió con una sala nueva
          if(d.nowPlaying)applyNp(d.nowPlaying);
          if(d.sfu&&d.sfu.sessionId&&d.sfu.trackName){
            await this.connectSfuGuest(d.sfu);
            if(this.mode==='sfu')return;
          }
          if(this.claimed&&d.hostCandidates)await this.addCands(d.hostCandidates);
        }else if(p==='/'&&d===null){   // el host cerró la sala a propósito
          $('gStats').textContent='El anfitrión cerró la sala.';
          this.end('IDLE');
        }else if(p==='/hb'){
          this.lastHb=Date.now();this.hbSeen=true;
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
  },
  async connectSfuGuest(sfu){
    const key=`${sfu.sessionId}:${sfu.trackName}`;
    if(this.sfuKey===key||Date.now()<this.sfuNext)return;
    // Ya conectado por P2P: no tumbamos una conexión buena por probar el SFU
    if(this.claimed&&this.pc&&this.pc.connectionState==='connected')return;
    this.sfuKey=key;
    this.mode='sfu';
    this.claimed=false;this.waiting=false;this.gReady=false;
    clearTimeout(this.waitTimer);
    if(!this.hbTimer)this.startPresence('wait');   // el host nos verá (y aprobará) por la presencia
    this.state('CONNECTING');
    $('gStats').textContent='Conectando por Cloudflare SFU…';
    // El plazo se arma UNA sola vez: antes cada reintento lo reiniciaba y el invitado se quedaba en "Conectando…" para siempre
    if(!this.sfuArmed){this.sfuArmed=true;this.armConn(C.CONN_MS)}
    if(this.pc){try{this.pc.close()}catch{}this.pc=null}
    try{
      // Flujo documentado de Cloudflare para RECIBIR pistas: pedir la pista remota SIN oferta propia;
      // Cloudflare devuelve una OFERTA, el cliente responde con una respuesta y la envía a /renegotiate.
      const ses=await sfuCall('/sessions/new','POST');
      const sid=ses.sessionId;
      if(!sid)throw new Error('SFU sin sessionId');
      const tr=await sfuCall(`/sessions/${sid}/tracks/new`,'POST',{
        tracks:[{location:'remote',sessionId:sfu.sessionId,trackName:sfu.trackName}]
      });
      if(!tr.sessionDescription||!tr.sessionDescription.sdp)throw new Error('SFU no devolvió oferta');
      const pc=await this.mkPc(true);
      await pc.setRemoteDescription({type:'offer',sdp:tr.sessionDescription.sdp});
      const ans=await pc.createAnswer();
      ans.sdp=tuneOpus(ans.sdp);
      await pc.setLocalDescription(ans);
      await sfuCall(`/sessions/${sid}/renegotiate`,'PUT',{
        sessionDescription:{type:'answer',sdp:ans.sdp}
      });
    }catch(e){
      console.error('[Shelyn] Error SFU invitado:',e);
      if(this.dead)return;
      this.sfuKey=null;this.sfuNext=Date.now()+4000;   // reintento en el próximo sondeo
      if(this.pc){try{this.pc.close()}catch{}this.pc=null}
      $('gStats').textContent='Error en la sala grupal, reintentando… ('+(e&&e.message||e)+')';
    }
  },
});
