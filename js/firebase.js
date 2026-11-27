'use strict';
/* Auth anónima de Firebase + helpers REST (get/put/patch/post/del/putIfEmpty) */

/* ---------- FIREBASE ANONYMOUS AUTH (JWT REAL) ---------- */
let authState={token:null,uid:null,exp:0,refresh:null},authBusy=null;
// La sesión sobrevive a recargas de la pestaña (sessionStorage): mismo uid => el host sigue siendo dueño de su sala
try{const s=JSON.parse(sessionStorage.getItem('shelyn_auth')||'null');if(s&&s.uid&&s.refresh)authState={token:null,uid:s.uid,exp:0,refresh:s.refresh}}catch{}
const saveAuth=()=>{try{sessionStorage.setItem('shelyn_auth',JSON.stringify({uid:authState.uid,refresh:authState.refresh}))}catch{}};
async function getAuth(){
  if(authState.token&&Date.now()<authState.exp)return authState;
  if(!authBusy)authBusy=renewAuth().finally(()=>{authBusy=null});
  return authBusy;
}
// Renovación anticipada: en sesiones largas el token se cambia antes de caducar, sin esperar a que una petición falle
setInterval(()=>{
  if(authState.token&&authState.refresh&&!authBusy&&authState.exp-Date.now()<600000){
    authBusy=renewAuth().finally(()=>{authBusy=null});
    authBusy.catch(()=>{});
  }
},60000);
async function renewAuth(){
  // 1) Renovar con refresh token: conserva el MISMO uid (necesario para seguir siendo owner de la sala).
  //    Requiere "Token Service API" en las restricciones de la clave.
  if(authState.refresh){
    let lastErr=null;
    for(let i=0;i<3;i++){
      try{
        const r=await fetch(`https://securetoken.googleapis.com/v1/token?key=${C.KEY}`,{
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:'grant_type=refresh_token&refresh_token='+encodeURIComponent(authState.refresh)
        });
        if(r.ok){
          const d=await r.json();
          authState={token:d.id_token,uid:d.user_id,refresh:d.refresh_token||authState.refresh,
            exp:Date.now()+(Number(d.expires_in||3600)-120)*1000};
          saveAuth();
          return authState;
        }
        if(r.status>=400&&r.status<500&&r.status!==429){lastErr=null;break}   // rechazo definitivo del refresh token
        lastErr=new Error('Auth refresh '+r.status);
      }catch(e){lastErr=e}
      await sleep(600*(i+1));
    }
    // Fallo transitorio (red/5xx): NO se crea otro uid (se perdería la propiedad de la sala); se reintentará
    if(lastErr)throw lastErr;
  }
  // 2) Sesión anónima nueva
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${C.KEY}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({returnSecureToken:true})
  });
  if(!r.ok)throw new Error('Auth '+r.status);
  const d=await r.json();
  authState={token:d.idToken,uid:d.localId,refresh:d.refreshToken||null,
    exp:Date.now()+(Number(d.expiresIn||3600)-120)*1000};
  saveAuth();
  return authState;
}
const fbUrl=(p,tok)=>`${C.DB}/${p}.json?auth=${encodeURIComponent(tok)}`;

/* ---------- FIREBASE REST + SSE AUTENTICADO ---------- */
async function fbGet(p){const {token}=await getAuth();const r=await fetch(fbUrl(p,token));if(!r.ok)throw new Error('FB GET '+r.status);return r.json()}
async function fbPut(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB PUT '+r.status)}
async function fbPatch(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB PATCH '+r.status)}
async function fbPost(p,d){const {token}=await getAuth();const r=await fetch(fbUrl(p,token),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});if(!r.ok)throw new Error('FB POST '+r.status)}
async function fbDel(p){try{const {token}=await getAuth();await fetch(fbUrl(p,token),{method:'DELETE'})}catch{}}
/* Escritura ATÓMICA "solo si está vacío" (igual que la app Android): el primero gana, el resto recibe 'conflict'.
   Si el navegador no deja enviar la cabecera if-match (CORS), se cae a leer + escribir + releer. */
async function fbPutIfEmpty(p,d){
  const {token}=await getAuth();
  try{
    const r=await fetch(fbUrl(p,token),{method:'PUT',headers:{'Content-Type':'application/json','if-match':'null_etag'},body:JSON.stringify(d)});
    if(r.ok)return 'ok';
    if(r.status===412)return 'conflict';
    throw new Error('FB PUT '+r.status);
  }catch(e){
    if(!(e instanceof TypeError))throw e;
    const cur=await fbGet(p).catch(()=>null);
    if(cur)return 'conflict';
    await fbPut(p,d);
    const chk=await fbGet(p).catch(()=>null);
    return chk&&chk.sdp===d.sdp?'ok':'conflict';
  }
}
