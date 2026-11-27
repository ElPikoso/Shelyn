'use strict';
/* UI: panel anfitrión (compartir, crear sala) */

/* ---------- CONTROLES HOST ---------- */
function hostUi(s){
  pill($('hPill'),s);const live=LIVE(s);
  $('hostBtn').textContent=live?'Detener transmisión':'Elegir pestaña y crear sala';
  $('hostBtn').className='btn'+(live?' stop':'');
  $('shareBtn').hidden=!live;
  if(!live)showPeople('hPeople',[]);
  if(!live){$('hCode').textContent='– – – –';$('hCode').className='code off'}
}

/* Elige el código de sala: reutiliza el último si sigue siendo tuyo, descarta ocupados y limpia salas colgadas */
async function pickCode(){
  try{
    const {uid}=await getAuth();
    let saved=0;try{saved=+sessionStorage.getItem('shelyn_hcode')||0}catch{}
    const cand=[];
    if(/^[1-9][0-9]{3}$/.test(String(saved)))cand.push(saved);
    for(let i=0;i<12;i++)cand.push(Math.floor(1000+Math.random()*9000));
    for(const c of cand){
      const r=await fbGet(`salas/${c}`).catch(()=>undefined);
      if(r===undefined)continue;                         // error de red/permiso: probar otro
      if(r===null||r.owner===uid)return c;               // libre o mía
      if(r.hb&&Date.now()-r.hb>C.ROOM_STALE_MS){         // colgada: intentar borrarla
        await fbDel(`salas/${c}`);
        if(await fbGet(`salas/${c}`).catch(()=>undefined)===null)return c;
      }
    }
  }catch{}
  return 0;
}

// Cerrar o recargar la pestaña sin pulsar "Detener": sin invitados se borra la sala; con invitados se conserva unos minutos
addEventListener('pagehide',()=>{
  const r=hostRoom;
  if(!r||r.dead||!authState.token)return;
  if(Object.keys(r.gmap).length)return;   // hay invitados: la sala se conserva para que el host pueda volver (plazo de gracia)
  try{fetch(fbUrl(`salas/${r.code}`,authState.token),{method:'DELETE',keepalive:true})}catch{}
});

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
  const code=await pickCode();
  if(!code){
    stream.getTracks().forEach(t=>t.stop());
    $('hWarn').textContent='No se pudo reservar un código de sala. Inténtalo de nuevo.';
    return;
  }
  try{sessionStorage.setItem('shelyn_hcode',code)}catch{}
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
