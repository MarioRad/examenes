'use strict';

/**
 * Evaluacion automatica de preguntas 'choice'.
 *
 *  - Simple (1 sola correcta): acierto = puntos, resto = 0.
 *  - Multiple (varias correctas): puntos proporcionales
 *        puntos * max(0, aciertos - errores) / total_correctas
 *      redondeado a 2 decimales por pregunta y con minimo 0.
 *
 * Las preguntas 'desarrollo' se corrigen manualmente desde /admin
 * y aqui siempre aportan 0 hasta que el profesor cargue la nota.
 */

function parseArray(texto) {
  if (!texto) return [];
  try {
    const v = JSON.parse(texto);
    return Array.isArray(v) ? v.map(Number) : [Number(v)];
  } catch {
    return [];
  }
}

/**
 * @param {Array} preguntas  filas de la tabla Preguntas
 * @param {Object} respuestas  { [preguntaId]: valor }
 *   - choice  -> Array de indices seleccionados  (o number/number[] serializado)
 *   - desarrollo -> string (HTML de Quill)
 * @returns {{choice: number, detalle: Array}}
 */
function evaluarChoice(preguntas, respuestas) {
  let total = 0;
  const detalle = [];

  for (const p of preguntas) {
    if (p.tipo !== 'choice') continue;

    const correctas = parseArray(p.respuesta_correcta);
    const puntos = Number(p.puntos) || 0;
    const bruto = respuestas ? respuestas[p.id] : undefined;

    let seleccionados = [];
    if (Array.isArray(bruto)) seleccionados = bruto.map(Number);
    else if (typeof bruto === 'string' && bruto !== '') {
      try {
        const v = JSON.parse(bruto);
        seleccionados = Array.isArray(v) ? v.map(Number) : [Number(v)];
      } catch {
        seleccionados = [Number(bruto)];
      }
    } else if (typeof bruto === 'number') seleccionados = [bruto];

    seleccionados = seleccionados.filter((n) => Number.isInteger(n));

    const correctasSet = new Set(correctas);
    const aciertos = seleccionados.filter((s) => correctasSet.has(s)).length;
    const errores = seleccionados.filter((s) => !correctasSet.has(s)).length;

    let obt = 0;
    if (correctas.length === 1) {
      obt = aciertos === 1 && errores === 0 ? puntos : 0;
    } else if (correctas.length > 1) {
      // Puntajes con decimales: se redondea a 2 decimales por pregunta.
      obt = Math.round((puntos * Math.max(0, aciertos - errores) / correctas.length) * 100) / 100;
    }

    total += obt;
    detalle.push({ id: p.id, puntos, obtenidos: obt, aciertos, errores, correctas: correctas.length });
  }

  return { choice: Math.round(total * 100) / 100, detalle };
}

module.exports = { evaluarChoice, parseArray };
