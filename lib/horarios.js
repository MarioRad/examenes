'use strict';

/**
 * Control de horario estricto por grupo (Grupos: dia 0-6, hora_desde/hora_hasta 'HH:MM').
 * Los horarios se leen de la tabla Grupos; los dias siguen la convencion de Date:
 * 0=domingo ... 6=sabado.
 */

const { stmts } = require('./db');

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DURACION_DEFAULT_MIN = 60;

// Los horarios son de la institucion, no del servidor: en Vercel el proceso corre en UTC.
const TZ = 'America/Argentina/Salta';

const fmtZona = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/** Dia de la semana (0=domingo) y minutos transcurridos del dia en la zona del examen. */
function ahoraEnZona(fecha = new Date()) {
  const p = fmtZona
    .formatToParts(fecha)
    .reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  const dia = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  const hora = Number(p.hour) === 24 ? 0 : Number(p.hour);
  return { dia, minutos: hora * 60 + Number(p.minute) };
}

function minutosDe(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function bypassActivo() {
  return process.env.DEV_BYPASS_SCHEDULE === '1';
}

/**
 * @param {number} grupoId
 * @param {Date} [ahora]
 * @returns {{ok: boolean, motivo?: string, bypass?: boolean}}
 */
async function validarHorario(grupoId, ahora = new Date()) {
  const grupo = await stmts.getGrupo.get(Number(grupoId) || 0);
  if (!grupo) return { ok: false, motivo: 'Grupo invalido.' };
  if (bypassActivo()) return { ok: true, bypass: true };

  const desde = minutosDe(grupo.hora_desde);
  const hasta = minutosDe(grupo.hora_hasta);
  if (desde == null || hasta == null) {
    return { ok: false, motivo: 'Horario del grupo mal configurado.' };
  }

  const { dia: diaSemana, minutos } = ahoraEnZona(ahora);
  const label = await ventanaDe(grupo.id);

  if (diaSemana !== grupo.dia) {
    return { ok: false, motivo: `Fuera de horario. Tu grupo solo puede acceder ${label}.` };
  }
  if (minutos < desde || minutos >= hasta) {
    return { ok: false, motivo: `Fuera de horario. Tu grupo solo puede acceder ${label}.` };
  }
  return { ok: true };
}

async function ventanaDe(grupoId) {
  const grupo = await stmts.getGrupo.get(Number(grupoId) || 0);
  if (!grupo) return '';
  const dia = DIAS[grupo.dia] || '?';
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${capitalize(dia)} de ${grupo.hora_desde} a ${grupo.hora_hasta} hs`;
}

/** Duracion de resolucion configurada en la materia (60 min por defecto). */
function duracionExamenMs(materia) {
  const min = Number(materia && materia.duracion_minutos);
  const minutos = Number.isFinite(min) && min > 0 ? min : DURACION_DEFAULT_MIN;
  return minutos * 60 * 1000;
}

/** 'YYYY-MM-DD HH:MM' -> 'dd/mm/aaaa hh:mm'. */
function fechaLegible(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : String(ts || '—');
}

/**
 * Ventana de ejecucion del examen (fecha/hora desde y hasta) definida en la materia.
 * Devuelve null si la materia no tiene ventana configurada.
 *
 * @param {object} materia  fila con disponible_desde / disponible_hasta
 * @param {string} ahora    'YYYY-MM-DD HH:MM:SS' en hora del servidor
 * @returns {null | {ok: boolean, motivo?: string}}
 */
function ventanaExamen(materia, ahora) {
  const desde = materia && materia.disponible_desde;
  const hasta = materia && materia.disponible_hasta;
  if (!desde || !hasta) return null;

  const ahoraMin = String(ahora || '').slice(0, 16);
  if (ahoraMin < desde) {
    return { ok: false, motivo: `El examen esta disponible desde el ${fechaLegible(desde)}.` };
  }
  if (ahoraMin > hasta) {
    return { ok: false, motivo: `El examen estuvo disponible hasta el ${fechaLegible(hasta)}.` };
  }
  return { ok: true };
}

/** Convierte 'YYYY-MM-DD HH:MM[:SS]' al epoch tratandolo como hora local uniforme. */
function aEpoch(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(ts || ''));
  if (!m) return null;
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  );
}

/**
 * Minutos que faltan para `objetivo` segun la hora del servidor.
 * Devuelve null si la materia no tiene fecha de cierre.
 */
function minutosHastaVentana(materia, ahoraTexto) {
  const hasta = materia && materia.disponible_hasta;
  if (!hasta) return null;
  const a = aEpoch(ahoraTexto);
  const b = aEpoch(hasta);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 60000);
}

/** Texto para mostrar la ventana de ejecucion en la vista del examen. */
function etiquetaVentana(materia) {
  const desde = materia && materia.disponible_desde;
  const hasta = materia && materia.disponible_hasta;
  if (!desde || !hasta) return null;
  return `del ${fechaLegible(desde)} al ${fechaLegible(hasta)}`;
}

module.exports = {
  validarHorario,
  ventanaDe,
  ventanaExamen,
  etiquetaVentana,
  duracionExamenMs,
  minutosHastaVentana,
  ahoraEnZona,
  fechaLegible,
  DIAS,
  minutosDe
};
