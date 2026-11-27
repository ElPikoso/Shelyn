'use strict';
/* ICE/TURN, cliente Cloudflare SFU, SDP Opus y prioridad del emisor */

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
  if(!r.ok){let t='';try{t=(await r.text()).slice(0,200)}catch{}throw new Error(`SFU ${r.status} ${method} ${path} ${t}`)}
  const d=await r.json();
  // Cloudflare a veces responde 200 con errorCode en el cuerpo o dentro de tracks[]
  const te=d&&d.tracks&&d.tracks.find&&d.tracks.find(t=>t&&t.errorCode);
  if(d&&(d.errorCode||te))throw new Error(`SFU ${path}: ${d.errorCode||te.errorCode} ${d.errorDescription||(te&&te.errorDescription)||''}`);
  return d;
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
