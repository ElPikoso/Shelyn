'use strict';
/* Now Playing: lado anfitrión (detección del título y publicación) */

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
