const C={
  DB:'https://shelyn-86208-default-rtdb.europe-west1.firebasedatabase.app',
  KEY:'AIzaSyCs-uCindNEB647fzhdZn2gLW52zigJwMg',
  BASE:'https://elpikoso.github.io/Shelyn/',
  SFU_PROXY:'https://shelyn-sfu.xterrablazexop.workers.dev',
  STUN:'stun:stun.l.google.com:19302',
  BR:96000,        // Opus estéreo 96 kbps
  JB:15,           // jitterBufferTarget (ms) en primer plano
  JBH:40,          // jitterBufferTarget (ms) en segundo plano
  PT:10,           // ptime (ms)
  MAXPT:20,        // maxptime (ms)
  MODAL_MS:45000,   // tiempo que tiene el host para aceptar
  CONN_MS:60000,    // tiempo máximo del invitado esperando conexión (incluye la aprobación del host)
  WAIT_MS:120000,   // tiempo máximo de un invitado en cola esperando la sala grupal
  HB_MS:15000,      // latido de presencia del invitado
  STALE_MS:45000,   // invitado sin latido => se da por ido
  HOST_HB_MS:10000, // latido del host en la sala (salas/{código}/hb)
  HOST_LOST_MS:30000,   // el invitado da al host por desconectado tras este tiempo sin latido
  HOST_GRACE_MS:180000, // plazo para que el host vuelva; pasado esto la sala se cierra sola
  ROOM_STALE_MS:180000, // sala sin latido del host durante este tiempo => colgada (se puede limpiar)
  SFU_TRACK:'shelyn-audio'
};
