'use strict';

/**
 * Script de inicializacion (idempotente):
 *   node seed.js
 *
 * Crea las tablas e inserta la estructura de prueba:
 *   2 instituciones -> 4 materias -> 6 alumnos (3 sabado / 3 lunes)
 *   preguntas base por materia con puntajes 2, 3 y 5.
 */

require('dotenv').config();
const { db, stmts } = require('./lib/db');

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

function upsertInstitucion(nombre) {
  const existente = db.prepare('SELECT id FROM Instituciones WHERE nombre = ?').get(nombre);
  if (existente) return existente.id;
  return stmts.crearInstitucion.run(nombre).lastInsertRowid;
}

function upsertMateria({ nombre, institucion }) {
  const instId = upsertInstitucion(institucion);
  const existente = db
    .prepare('SELECT id FROM Materias WHERE nombre = ? AND institucion_id = ?')
    .get(nombre, instId);
  if (existente) return existente.id;
  return stmts.crearMateria.run(nombre, instId).lastInsertRowid;
}

function seed() {
  const run = db.transaction(() => {
    for (const m of materias) upsertMateria(m);

    for (const a of alumnos) {
      const materiaId = upsertMateria(
        materias.find((m) => m.nombre === a.materia) || materias[0]
      );
      const doc = String(a.documento);
      const existe = db
        .prepare('SELECT documento FROM Alumnos WHERE documento = ?')
        .get(doc);
      if (existe) continue;
      // Resuelve el nombre de grupo ('sabado'/'lunes') a su id en Grupos.
      const grupo = db
        .prepare('SELECT id FROM Grupos WHERE lower(nombre) = lower(?)')
        .get(a.grupo_dia);
      stmts.crearAlumno.run({
        documento: doc,
        nombre: a.nombre,
        email: a.email,
        grupo_id: grupo ? grupo.id : null,
        materia_id: materiaId
      });
    }

    const hayPreguntas = db.prepare('SELECT COUNT(*) AS n FROM Preguntas').get().n > 0;
    if (!hayPreguntas) {
      for (const p of preguntas) {
        const materiaId = upsertMateria(
          materias.find((m) => m.nombre === p.materia) || materias[0]
        );
        stmts.crearPregunta.run({
          texto: p.texto,
          tipo: p.tipo,
          opciones_json: p.opciones_json,
          respuesta_correcta: p.respuesta_correcta,
          puntos: p.puntos,
          materia_id: materiaId
        });
      }
    }
  });

  run();

  const c = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log('[seed] Esquema verificado/creado en database.db');
  console.log(`[seed] Instituciones: ${c('Instituciones')} | Materias: ${c('Materias')}`);
  console.log(`[seed] Alumnos: ${c('Alumnos')} | Preguntas: ${c('Preguntas')}`);
  console.log('[seed] Listo. Ejecuta: npm start');
}

seed();
