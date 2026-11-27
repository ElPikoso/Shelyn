'use strict';
/* UI: pestañas, jitter buffer, panel invitado */

/* ---------- UI ---------- */
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


const play=()=>a.play().then(()=>$('tap').hidden=true).catch(()=>$('tap').hidden=false);
$('tap').onclick=play;

function guestUi(s){
  pill($('gPill'),s);const live=LIVE(s);
  $('joinBtn').textContent=live?'Desconectar':'Unirse a la sala';
  $('joinBtn').className='btn'+(live?' stop':'');
  $('joinBtn').disabled=!live&&!codeOk();
  $('code').disabled=live;
  $('nick').disabled=live;
  if(!live)showPeople('gPeople',[]);
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

try{$('nick').value=localStorage.getItem('shelyn_nick')||''}catch{}
$('nick').oninput=()=>{try{localStorage.setItem('shelyn_nick',$('nick').value)}catch{}};

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


// Auto-rellenar código desde ?sala=1234
const q=new URLSearchParams(location.search).get('sala');
if(q&&/^[1-9][0-9]{3}$/.test(q)){$('code').value=q;$('joinBtn').disabled=false}
