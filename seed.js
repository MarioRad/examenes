'use strict';

/**
 * Script de inicializacion (idempotente):
 *   node seed.js
 *
 * Crea las tablas e inserta la estructura de prueba:
 *   2 instituciones -> 4 materias -> 6 alumnos (3 sabado / 3 lunes)
 *   preguntas base por materia con puntajes 2, 3 y 5.
 *
 * Usa la misma base que la app (TURSO_DATABASE_URL o database.db local).
 */

require('dotenv').config();
const { stmts, ready, one } = require('./lib/db');

const instituciones = ['Instituto San Martin', 'Escuela Tecnica Norte'];

const materias = [
  { nombre: 'Bases de Datos', institucion: 'Instituto San Martin' },
  { nombre: 'Programacion', institucion: 'Instituto San Martin' },
  { nombre: 'Redes', institucion: 'Escuela Tecnica Norte' },
  { nombre: 'Matematica', institucion: 'Escuela Tecnica Norte' }
];

const alumnos = [
  { documento: '28456789', nombre: 'Lucia Fernandez', email: 'lucia.fernandez@example.com', grupo_dia: 'sabado', materia: 'Bases de Datos' },
  { documento: '31234567', nombre: 'Martin Gomez', email: 'martin.gomez@example.com', grupo_dia: 'sabado', materia: 'Bases de Datos' },
  { documento: '35765432', nombre: 'Sofia Rios', email: 'sofia.rios@example.com', grupo_dia: 'sabado', materia: 'Programacion' },
  { documento: '27111222', nombre: 'Diego Paz', email: 'diego.paz@example.com', grupo_dia: 'lunes', materia: 'Redes' },
  { documento: '33999888', nombre: 'Carla Nunez', email: 'carla.nunez@example.com', grupo_dia: 'lunes', materia: 'Redes' },
  { documento: '40555666', nombre: 'Juan Torres', email: 'juan.torres@example.com', grupo_dia: 'lunes', materia: 'Matematica' }
];

const preguntas = [
  // --- Bases de Datos ---
  { materia: 'Bases de Datos', texto: '¿Que entiendes por "normalizacion" en bases de datos relacionales? Explica con un ejemplo.', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 3 },
  { materia: 'Bases de Datos', texto: '¿Cuales de las siguientes opciones son tipos de datos numericos en SQLite?', tipo: 'choice', opciones_json: JSON.stringify(['INTEGER', 'VARCHAR', 'REAL', 'BLOB']), respuesta_correcta: JSON.stringify([0, 2]), puntos: 5 },
  { materia: 'Bases de Datos', texto: 'Que significa que la tabla "Respuestas" tenga un constraint UNIQUE en documento_alumno?', tipo: 'choice', opciones_json: JSON.stringify(['Que un alumno puede entregar varias veces', 'Que cada alumno solo puede tener una fila de entrega', 'Que el documento debe ser numerico', 'Que se borran las respuestas antiguas']), respuesta_correcta: JSON.stringify([1]), puntos: 2 },

  // --- Programacion ---
  { materia: 'Programacion', texto: 'Explica la diferencia entre HTTP y HTTPS, y por que es importante usar HTTPS en un sistema de examenes.', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 5 },
  { materia: 'Programacion', texto: '¿Cual de estos NO es un lenguaje de programacion?', tipo: 'choice', opciones_json: JSON.stringify(['Python', 'HTML', 'JavaScript', 'Java']), respuesta_correcta: JSON.stringify([1]), puntos: 2 },
  { materia: 'Programacion', texto: 'Que es una funcion y para que sirve en un programa?', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 3 },

  // --- Redes ---
  { materia: 'Redes', texto: 'Describe como funciona el evento "visibilitychange" y para que lo utilizariais en un examen en linea.', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 3 },
  { materia: 'Redes', texto: '¿Que protocolo se usa para transferir paginas web de forma segura?', tipo: 'choice', opciones_json: JSON.stringify(['FTP', 'HTTP', 'HTTPS', 'SMTP']), respuesta_correcta: JSON.stringify([2]), puntos: 2 },
  { materia: 'Redes', texto: 'Que es una direccion IP y para que sirve?', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 5 },

  // --- Matematica ---
  { materia: 'Matematica', texto: 'Resuelve y explica: ¿cuanto es 15% de 240?', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 2 },
  { materia: 'Matematica', texto: '¿Cual es la formula general de la ecuacion de segundo grado?', tipo: 'choice', opciones_json: JSON.stringify(['x = -b ± √(b²-4ac) / 2a', 'x = -b ± √(b²+4ac) / 2a', 'x = b ± √(b²-4ac) / 2a', 'x = -b ± √(b²-4ac) / 4a']), respuesta_correcta: JSON.stringify([0]), puntos: 3 },
  { materia: 'Matematica', texto: 'Explica que es una funcion lineal con un ejemplo grafico.', tipo: 'desarrollo', opciones_json: null, respuesta_correcta: null, puntos: 3 }
];

async function upsertInstitucion(nombre) {
  const existente = await one('SELECT id FROM Instituciones WHERE nombre = ?', [nombre]);
  if (existente) return existente.id;
  return (await stmts.crearInstitucion.run(nombre)).lastInsertRowid;
}

async function upsertMateria({ nombre, institucion }) {
  const instId = await upsertInstitucion(institucion);
  const existente = await one(
    'SELECT id FROM Materias WHERE nombre = ? AND institucion_id = ?',
    [nombre, instId]
  );
  if (existente) return existente.id;
  return (await stmts.crearMateria.run(nombre, instId, null, null, null)).lastInsertRowid;
}

async function seed() {
  await ready;

  for (const m of materias) await upsertMateria(m);

  for (const a of alumnos) {
    const materiaId = await upsertMateria(
      materias.find((m) => m.nombre === a.materia) || materias[0]
    );
    const doc = String(a.documento);
    const existe = await one('SELECT documento FROM Alumnos WHERE documento = ?', [doc]);
    if (existe) continue;
    // Resuelve el nombre de grupo ('sabado'/'lunes') a su id en Grupos.
    const grupo = await one('SELECT id FROM Grupos WHERE lower(nombre) = lower(?)', [a.grupo_dia]);
    await stmts.crearAlumno.run(
      doc,
      a.nombre,
      a.email,
      grupo ? grupo.id : null,
      materiaId
    );
  }

  const hayPreguntas = Number((await one('SELECT COUNT(*) AS n FROM Preguntas')).n) > 0;
  if (!hayPreguntas) {
    for (const p of preguntas) {
      const materiaId = await upsertMateria(
        materias.find((m) => m.nombre === p.materia) || materias[0]
      );
      await stmts.crearPregunta.run(
        p.texto,
        p.tipo,
        p.opciones_json,
        p.respuesta_correcta,
        p.puntos,
        materiaId
      );
    }
  }

  const c = async (t) => Number((await one(`SELECT COUNT(*) AS n FROM ${t}`)).n);
  console.log('[seed] Esquema verificado/creado');
  console.log(`[seed] Instituciones: ${await c('Instituciones')} | Materias: ${await c('Materias')}`);
  console.log(`[seed] Alumnos: ${await c('Alumnos')} | Preguntas: ${await c('Preguntas')}`);
  console.log('[seed] Listo. Ejecuta: npm start');
}

seed().catch((e) => {
  console.error('[seed] error:', e);
  process.exit(1);
});
