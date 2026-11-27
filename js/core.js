'use strict';
/* Utilidades, estados de la UI y variables globales compartidas */

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

/* Apodos y lista de conectados (textContent: un apodo nunca se interpreta como HTML) */
const nickName=v=>String(v||'').trim().slice(0,20);
function showPeople(id,list,onKick){
  const el=$(id);el.hidden=!list.length;
  const key=JSON.stringify(list);
  if(el.dataset.key===key)return;   // no redibujar en cada sondeo (se perderían clics)
  el.dataset.key=key;
  el.textContent=list.length?`Conectados (${list.length}):`:'';
  for(const p of list){
    const row=document.createElement('span');
    row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px';
    row.textContent=p.label??p;
    if(onKick&&p.id!=='__host'){
      const b=document.createElement('button');
      b.type='button';b.textContent='Echar';b.className='btn stop';
      b.style.cssText='width:auto;margin:0;padding:4px 10px';
      b.onclick=()=>onKick(p.id);
      row.append(b);
    }
    el.append(row);
  }
}

/* Estado compartido entre archivos */
let hostRoom=null,guestRoom=null,rxr=null;
