'use strict';

/**
 * Control de horario estricto por grupo (Grupos: dia 0-6, hora_desde/hora_hasta 'HH:MM').
 * Los horarios se leen de la tabla Grupos; los dias siguen la convencion de Date:
 * 0=domingo ... 6=sabado.
 */

const { stmts } = require('./db');

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

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
function validarHorario(grupoId, ahora = new Date()) {
  const grupo = stmts.getGrupo.get(Number(grupoId) || 0);
  if (!grupo) return { ok: false, motivo: 'Grupo invalido.' };
  if (bypassActivo()) return { ok: true, bypass: true };

  const desde = minutosDe(grupo.hora_desde);
  const hasta = minutosDe(grupo.hora_hasta);
  if (desde == null || hasta == null) {
    return { ok: false, motivo: 'Horario del grupo mal configurado.' };
  }

  const diaSemana = ahora.getDay();
  const minutos = ahora.getHours() * 60 + ahora.getMinutes();
  const label = ventanaDe(grupo.id);

  if (diaSemana !== grupo.dia) {
    return { ok: false, motivo: `Fuera de horario. Tu grupo solo puede acceder ${label}.` };
  }
  if (minutos < desde || minutos >= hasta) {
    return { ok: false, motivo: `Fuera de horario. Tu grupo solo puede acceder ${label}.` };
  }
  return { ok: true };
}

function ventanaDe(grupoId) {
  const grupo = stmts.getGrupo.get(Number(grupoId) || 0);
  if (!grupo) return '';
  const dia = DIAS[grupo.dia] || '?';
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${capitalize(dia)} de ${grupo.hora_desde} a ${grupo.hora_hasta} hs`;
}

module.exports = { validarHorario, ventanaDe, DIAS, minutosDe };
