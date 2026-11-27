'use strict';
/* Auth anónima de Firebase + helpers REST (get/put/patch/post/del/putIfEmpty) */

/* ---------- FIREBASE ANONYMOUS AUTH (JWT REAL) ---------- */
let authState={token:null,uid:null,exp:0,refresh:null},authBusy=null;
async function getAuth(){
  if(authState.token&&Date.now()<authState.exp)return authState;
  if(!authBusy)authBusy=renewAuth().finally(()=>{authBusy=null});
  return authBusy;
}
async function renewAuth(){
  // 1) Renovar con refresh token: conserva el MISMO uid (necesario para seguir siendo owner de la sala).
  //    Requiere "Token Service API" en las restricciones de la clave; si falla, se cae al paso 2.
  if(authState.refresh){
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
        return authState;
      }
    }catch{}
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
