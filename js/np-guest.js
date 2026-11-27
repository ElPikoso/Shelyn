'use strict';
/* Now Playing: lado invitado (tarjeta, Media Session) */

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
// Título de la pestaña: "♪ Canción · Artista · Shelyn" mientras hay pista; al salir se restaura el original
const NP_BASE_TITLE=document.title;let npTitleSet=false;
function npTabTitle(){
  const n=npCur;
  if(npVisible&&n){
    document.title='♪ '+n.title+(n.artist?' · '+n.artist:'')+' · Shelyn';
    npTitleSet=true;
  }else if(npTitleSet){
    document.title=NP_BASE_TITLE;npTitleSet=false;
  }
}
function renderNp(){
  const c=$('npCard'),n=npCur,img=$('npImg');
  c.hidden=!npVisible;
  npTabTitle();
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


// Carátula: mostrar solo si carga; si falla, queda el icono
$('npImg').onload=()=>{$('npImg').hidden=false};
$('npImg').onerror=()=>{$('npImg').hidden=true};
