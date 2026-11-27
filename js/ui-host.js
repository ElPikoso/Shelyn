'use strict';
/* UI: panel anfitrión (compartir, crear sala) */

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
