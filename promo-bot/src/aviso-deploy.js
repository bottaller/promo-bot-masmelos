// Aviso de DEPLOY: al arrancar, si el commit que Railway acaba de deployar es NUEVO (distinto del
// último anunciado), le avisa a los admins "🚀 Deploy terminado: commit X por Y". Un reinicio del
// MISMO commit (crash, mantenimiento de Railway) NO re-anuncia — se compara contra bot.deploys.
//
// Los datos del commit salen de las env vars que Railway inyecta al deployar desde GitHub
// (RAILWAY_GIT_COMMIT_SHA / _AUTHOR / _COMMIT_MESSAGE). Si no están (corrida local), no anuncia.
// Los require de la capa DB son LAZY (adentro de anunciarDeploy) A PROPÓSITO: db/pool.js tira al
// cargarse si falta DATABASE_URL, y así los tests corren sin base inyectando las deps.

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Info del commit deployado, desde las env vars de Railway (con fallbacks por si cambian el nombre).
function infoCommit(env = process.env) {
  const primero = (...keys) => { for (const k of keys) if (env[k]) return String(env[k]).trim(); return ''; };
  return {
    sha: primero('RAILWAY_GIT_COMMIT_SHA', 'GIT_COMMIT_SHA', 'COMMIT_SHA', 'SOURCE_COMMIT'),
    autor: primero('RAILWAY_GIT_AUTHOR', 'GIT_AUTHOR', 'COMMIT_AUTHOR'),
    mensaje: primero('RAILWAY_GIT_COMMIT_MESSAGE', 'GIT_COMMIT_MESSAGE', 'COMMIT_MESSAGE'),
  };
}

// Arma el texto del aviso. PURO (testeable).
function mensajeDeploy({ sha, autor, mensaje }) {
  const corto = String(sha || '').slice(0, 7);
  const subject = (String(mensaje || '').split('\n')[0] || '').slice(0, 140);
  return `🚀 <b>Deploy terminado</b>\n` +
    `commit <code>${escapeHtml(corto)}</code>${autor ? ` · por ${escapeHtml(autor)}` : ''}` +
    (subject ? `\n<i>${escapeHtml(subject)}</i>` : '');
}

// Anuncia el deploy a los admins si el commit es nuevo. NUNCA tira: no debe romper el arranque.
// `deps` inyectable para test; las que no se inyectan se resuelven LAZY contra la DB.
async function anunciarDeploy(bot, deps = {}) {
  try {
    const infoFn = deps.infoFn || infoCommit;
    const { sha, autor, mensaje } = infoFn();
    if (!sha) { console.log('Aviso de deploy: sin SHA de commit (¿corrida local?), no anuncio.'); return { anunciado: false, avisados: 0, sha: '' }; }
    // Resolución LAZY de las deps de DB (require adentro para no cargar pool sin DATABASE_URL en tests).
    const ultimoFn = deps.ultimoFn || require('./db/deploys').ultimoDeploySha;
    const registrarFn = deps.registrarFn || require('./db/deploys').registrarDeploy;
    const adminsFn = deps.adminsFn || require('./db/usuarios').telegramIdsAdmins;

    const ultimo = await ultimoFn();
    if (ultimo === sha) { console.log(`Aviso de deploy: commit ${sha.slice(0, 7)} ya anunciado (reinicio), no repito.`); return { anunciado: false, avisados: 0, sha }; }

    const msg = mensajeDeploy({ sha, autor, mensaje });
    const admins = await adminsFn();
    let avisados = 0;
    for (const tid of admins) {
      try { await bot.telegram.sendMessage(tid, msg, { parse_mode: 'HTML' }); avisados++; }
      catch (e) { console.error(`Aviso de deploy: no pude avisar a ${tid}:`, e.message); }
    }
    // Registrar solo si llegó a alguien: si Telegram estaba caído, se reintenta en el próximo arranque.
    if (avisados > 0) await registrarFn({ sha, autor, mensaje });
    console.log(`Aviso de deploy: commit ${sha.slice(0, 7)} anunciado a ${avisados} admin/s.`);
    return { anunciado: avisados > 0, avisados, sha };
  } catch (e) {
    console.error('Aviso de deploy:', e.message);
    return { anunciado: false, avisados: 0, sha: '' };
  }
}

module.exports = { anunciarDeploy, infoCommit, mensajeDeploy };
