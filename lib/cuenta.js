'use strict';

/**
 * Cuenta del panel: nombre y apellido del profesor + clave de acceso.
 * La clave vive en la tabla Config (hash scrypt); si nunca se cambio,
 * sigue valiendo la del entorno ADMIN_PASSWORD.
 */

const crypto = require('crypto');
const { one, run } = require('./db');

async function getValor(clave) {
  const fila = await one('SELECT valor FROM Config WHERE clave = ?', [clave]);
  return fila ? fila.valor : null;
}

async function setValor(clave, valor) {
  await run(
    `INSERT INTO Config (clave, valor) VALUES (?, ?)
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
    [clave, valor == null ? '' : String(valor)]
  );
}

async function getProfesor() {
  const nombre = (await getValor('profesor_nombre')) || '';
  const apellido = (await getValor('profesor_apellido')) || '';
  return { nombre, apellido, completo: [nombre, apellido].filter(Boolean).join(' ') };
}

async function setProfesor(nombre, apellido) {
  await setValor('profesor_nombre', nombre);
  await setValor('profesor_apellido', apellido);
}

function hashClave(clave) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(clave), salt, 64).toString('hex');
  return JSON.stringify({ salt, hash });
}

function coincide(clave, guardada) {
  try {
    const { salt, hash } = JSON.parse(guardada);
    const calc = crypto.scryptSync(String(clave), salt, 64);
    const esperado = Buffer.from(hash, 'hex');
    return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
  } catch {
    return false;
  }
}

/** Valida la clave contra la guardada en Config o, en su defecto, contra el entorno. */
async function verificarClave(clave) {
  const guardada = await getValor('admin_password');
  if (guardada) return coincide(clave, guardada);
  return String(clave) === String(process.env.ADMIN_PASSWORD || 'admin123');
}

async function cambiarClave(nueva) {
  await setValor('admin_password', hashClave(nueva));
}

module.exports = { getProfesor, setProfesor, verificarClave, cambiarClave, getValor, setValor };
