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
function showPeople(id,list){
  const el=$(id);el.hidden=!list.length;
  el.textContent=list.length?`Conectados (${list.length}):\n${list.join('\n')}`:'';
}

/* Estado compartido entre archivos */
let hostRoom=null,guestRoom=null,rxr=null;
