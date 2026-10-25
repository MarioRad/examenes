'use strict';

/**
 * Capa de datos sobre libSQL (Turso en produccion, archivo local en desarrollo).
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN vienen del marketplace de Vercel; sin
 * ellas se usa database.db del proyecto (desarrollo).
 *
 * Todas las sentencias son asincronicas: `await stmts.x.get(...)`.
 */

const path = require('path');
const { createClient } = require('@libsql/client');

const LOCAL_DB = path.join(__dirname, '..', 'database.db');
const DB_URL = process.env.TURSO_DATABASE_URL || `file:${LOCAL_DB}`;
const DB_PATH = DB_URL.startsWith('file:') ? DB_URL.slice('file:'.length) : DB_URL;
const ES_REMOTA = /^(libsql|https?|wss?):/.test(DB_URL);

const client = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});

/** Convierte una fila de libSQL en un objeto plano (Row[] o Record[]). */
function fila(row) {
  if (row && Array.isArray(row.columns)) {
    const out = {};
    for (let i = 0; i < row.length; i++) out[row.columns[i]] = row[i];
    return out;
  }
  return { ...row };
}

async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.map(fila);
}

async function one(sql, args = []) {
  return (await all(sql, args))[0];
}

async function run(sql, args = []) {
  const res = await client.execute({ sql, args });
  return {
    rowsAffected: Number(res.rowsAffected) || 0,
    lastInsertRowid: res.lastInsertRowid == null ? null : Number(res.lastInsertRowid)
  };
}

/** Sentencia con la misma forma que better-sqlite3: .get/.all/.run. */
function stmt(sql) {
  return {
    get: (...args) => one(sql, args),
    all: (...args) => all(sql, args),
    run: (...args) => run(sql, args)
  };
}

async function columnas(tabla) {
  return (await all(`PRAGMA table_info(${tabla})`)).map((c) => c.name);
}

async function existeTabla(nombre) {
  return !!(await one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [
    nombre
  ]));
}

async function initSchema() {
  if (!ES_REMOTA) {
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA foreign_keys = ON');
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Instituciones (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT NOT NULL UNIQUE,
      pdf_titulo     TEXT,
      pdf_encabezado TEXT
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Materias (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre           TEXT NOT NULL,
      institucion_id   INTEGER REFERENCES Instituciones(id),
      duracion_minutos INTEGER,
      disponible_desde TEXT,
      disponible_hasta TEXT,
      profesor         TEXT
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Alumnos (
      documento  TEXT PRIMARY KEY,
      nombre     TEXT NOT NULL,
      email      TEXT NOT NULL,
      materia_id INTEGER REFERENCES Materias(id),
      grupo_id   INTEGER REFERENCES Grupos(id)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Preguntas (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      texto              TEXT NOT NULL,
      tipo               TEXT NOT NULL DEFAULT 'desarrollo' CHECK (tipo IN ('choice','desarrollo')),
      opciones_json      TEXT,
      respuesta_correcta TEXT,
      puntos             REAL NOT NULL DEFAULT 1,
      obligatoria        INTEGER NOT NULL DEFAULT 0,
      materia_id         INTEGER REFERENCES Materias(id)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Respuestas (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_alumno       TEXT NOT NULL,
      nombre_alumno          TEXT NOT NULL,
      materia_id             INTEGER REFERENCES Materias(id),
      respuestas_json        TEXT NOT NULL,
      puntaje_choice         REAL NOT NULL DEFAULT 0,
      puntaje_desarrollo     REAL NOT NULL DEFAULT 0,
      puntaje_total_obtenido REAL NOT NULL DEFAULT 0,
      timestamp_entrega      TEXT NOT NULL,
      abandonos_count        INTEGER NOT NULL DEFAULT 0,
      estado                 TEXT NOT NULL CHECK (estado IN ('entregado','expulsado')),
      devoluciones           TEXT,
      devoluciones_json      TEXT,
      puntajes_json          TEXT,
      corregido              INTEGER NOT NULL DEFAULT 0,
      pdf_enviado            INTEGER NOT NULL DEFAULT 0,
      pdf_titulo             TEXT,
      pdf_encabezado         TEXT,
      UNIQUE (documento_alumno)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Grupos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL UNIQUE,
      dia        INTEGER NOT NULL CHECK (dia BETWEEN 0 AND 6),
      hora_desde TEXT NOT NULL,
      hora_hasta TEXT NOT NULL
    );
  `);

  // Un statement por execute: Turso (hrana/http) rechaza varios en la misma cadena.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS Config (
      clave  TEXT PRIMARY KEY,
      valor  TEXT
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS Sesiones (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);

  await migrarEsquemaViejo();
  await migrarPreguntaObligatoria();
  await migrarCorreccionPorPregunta();
  await migrarExamenEnMaterias();
  await migrarProfesorMateria();
  await migrarEncabezadoInstitucion();
  await migrarGrupos();
  await asegurarGeneral();
}

/** Preguntas marcadas como obligatorias (no se puede entregar sin responderlas). */
async function migrarPreguntaObligatoria() {
  if (!(await columnas('Preguntas')).includes('obligatoria')) {
    await client.execute('ALTER TABLE Preguntas ADD COLUMN obligatoria INTEGER NOT NULL DEFAULT 0');
  }
}

/** Correccion por pregunta: puntaje de desarrollo y devolucion por respuesta. */
async function migrarCorreccionPorPregunta() {
  const c = await columnas('Respuestas');
  if (!c.includes('devoluciones_json')) {
    await client.execute('ALTER TABLE Respuestas ADD COLUMN devoluciones_json TEXT');
  }
  if (!c.includes('puntajes_json')) {
    await client.execute('ALTER TABLE Respuestas ADD COLUMN puntajes_json TEXT');
  }
  if (!c.includes('corregido')) {
    await client.execute('ALTER TABLE Respuestas ADD COLUMN corregido INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Configuracion del examen por materia: duracion de resolucion (minutos) y
 * ventana de fechas en la que se habilita la ejecucion.
 */
async function migrarExamenEnMaterias() {
  const c = await columnas('Materias');
  if (!c.includes('duracion_minutos')) {
    await client.execute('ALTER TABLE Materias ADD COLUMN duracion_minutos INTEGER');
  }
  if (!c.includes('disponible_desde')) {
    await client.execute('ALTER TABLE Materias ADD COLUMN disponible_desde TEXT');
  }
  if (!c.includes('disponible_hasta')) {
    await client.execute('ALTER TABLE Materias ADD COLUMN disponible_hasta TEXT');
  }
}

/** Profesor a cargo del examen (se imprime en la planilla de notas). */
async function migrarProfesorMateria() {
  if (!(await columnas('Materias')).includes('profesor')) {
    await client.execute('ALTER TABLE Materias ADD COLUMN profesor TEXT');
  }
}

/** Encabezado del PDF propio de cada institucion. */
async function migrarEncabezadoInstitucion() {
  const c = await columnas('Instituciones');
  if (!c.includes('pdf_titulo')) {
    await client.execute('ALTER TABLE Instituciones ADD COLUMN pdf_titulo TEXT');
  }
  if (!c.includes('pdf_encabezado')) {
    await client.execute('ALTER TABLE Instituciones ADD COLUMN pdf_encabezado TEXT');
  }
}

/** Migra bases creadas con el esquema anterior (codigo -> documento, +materia_id). */
async function migrarEsquemaViejo() {
  if (await existeTabla('Alumnos')) {
    const c = await columnas('Alumnos');
    if (c.includes('codigo') && !c.includes('documento')) {
      await client.execute('ALTER TABLE Alumnos RENAME COLUMN codigo TO documento');
    }
    if (!(await columnas('Alumnos')).includes('materia_id')) {
      await client.execute('ALTER TABLE Alumnos ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
    }
  }

  if (await existeTabla('Respuestas')) {
    const c = await columnas('Respuestas');
    if (c.includes('codigo_alumno') && !c.includes('documento_alumno')) {
      await client.execute('ALTER TABLE Respuestas RENAME COLUMN codigo_alumno TO documento_alumno');
    }
    if (!(await columnas('Respuestas')).includes('materia_id')) {
      await client.execute('ALTER TABLE Respuestas ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
    }
    if (!(await columnas('Respuestas')).includes('devoluciones')) {
      await client.execute('ALTER TABLE Respuestas ADD COLUMN devoluciones TEXT');
    }
    if (!(await columnas('Respuestas')).includes('pdf_enviado')) {
      await client.execute('ALTER TABLE Respuestas ADD COLUMN pdf_enviado INTEGER NOT NULL DEFAULT 0');
    }
    if (!(await columnas('Respuestas')).includes('pdf_titulo')) {
      await client.execute('ALTER TABLE Respuestas ADD COLUMN pdf_titulo TEXT');
    }
    if (!(await columnas('Respuestas')).includes('pdf_encabezado')) {
      await client.execute('ALTER TABLE Respuestas ADD COLUMN pdf_encabezado TEXT');
    }
  }

  if (await existeTabla('Preguntas')) {
    if (!(await columnas('Preguntas')).includes('materia_id')) {
      await client.execute('ALTER TABLE Preguntas ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
    }
  }
}

/**
 * Grupos: antes era un CHECK ('sabado','lunes') en Alumnos.grupo_dia.
 * Ahora tabla Grupos (nombre, dia 0-6, hora_desde, hora_hasta) y Alumnos.grupo_id.
 * Crea los grupos por defecto si la tabla esta vacia y migra las filas existentes.
 */
async function migrarGrupos() {
  const hayGrupos = (await one('SELECT COUNT(*) AS n FROM Grupos')).n;
  if (Number(hayGrupos) === 0) {
    await run('INSERT INTO Grupos (nombre, dia, hora_desde, hora_hasta) VALUES (?, ?, ?, ?)', [
      'Sabado', 6, '10:00', '14:00'
    ]);
    await run('INSERT INTO Grupos (nombre, dia, hora_desde, hora_hasta) VALUES (?, ?, ?, ?)', [
      'Lunes', 1, '14:00', '18:00'
    ]);
  }

  if (!(await existeTabla('Alumnos'))) return;
  const c = await columnas('Alumnos');
  if (!c.includes('grupo_dia')) return; // ya migrado (o base nueva sin legacy)

  if (!c.includes('grupo_id')) {
    await client.execute('ALTER TABLE Alumnos ADD COLUMN grupo_id INTEGER REFERENCES Grupos(id)');
  }

  // Backfill: mapea los valores viejos 'sabado'/'lunes' a los grupos por defecto.
  const gSab = await one('SELECT id FROM Grupos WHERE nombre = ?', ['Sabado']);
  const gLun = await one('SELECT id FROM Grupos WHERE nombre = ?', ['Lunes']);
  if (gSab) {
    await run('UPDATE Alumnos SET grupo_id = ? WHERE grupo_dia = ? AND grupo_id IS NULL', [
      gSab.id, 'sabado'
    ]);
  }
  if (gLun) {
    await run('UPDATE Alumnos SET grupo_id = ? WHERE grupo_dia = ? AND grupo_id IS NULL', [
      gLun.id, 'lunes'
    ]);
  }
  // Filas sin coincidencia caen al primer grupo disponible.
  const primero = await one('SELECT id FROM Grupos ORDER BY id LIMIT 1');
  if (primero) {
    await run('UPDATE Alumnos SET grupo_id = ? WHERE grupo_id IS NULL', [primero.id]);
  }

  await client.execute('ALTER TABLE Alumnos DROP COLUMN grupo_dia');
}

/**
 * Si quedaron filas sin materia_id (esquema anterior), crea
 * institucion/materia "General" y las asigna. En bases nuevas no hace nada.
 */
async function asegurarGeneral() {
  const sinMateria = (
    await one(
      `SELECT
         (SELECT COUNT(*) FROM Alumnos WHERE materia_id IS NULL) +
         (SELECT COUNT(*) FROM Preguntas WHERE materia_id IS NULL) +
         (SELECT COUNT(*) FROM Respuestas WHERE materia_id IS NULL) AS n`
    )
  ).n;
  if (Number(sinMateria) === 0) return;

  const inst = await one('SELECT id FROM Instituciones WHERE nombre = ?', ['General']);
  const instId =
    inst?.id ||
    (await run('INSERT INTO Instituciones (nombre) VALUES (?)', ['General'])).lastInsertRowid;

  const mat = await one('SELECT id FROM Materias WHERE institucion_id = ? AND nombre = ?', [
    instId, 'General'
  ]);
  const matId =
    mat?.id ||
    (await run('INSERT INTO Materias (nombre, institucion_id) VALUES (?, ?)', ['General', instId]))
      .lastInsertRowid;

  await run('UPDATE Alumnos SET materia_id = ? WHERE materia_id IS NULL', [matId]);
  await run('UPDATE Preguntas SET materia_id = ? WHERE materia_id IS NULL', [matId]);
  await run(
    `UPDATE Respuestas SET materia_id = COALESCE(
       materia_id,
       (SELECT materia_id FROM Alumnos WHERE documento = documento_alumno),
       ?
     )
     WHERE materia_id IS NULL`,
    [matId]
  );
}

const JOIN_ALUMNO = `
  LEFT JOIN Materias m ON m.id = a.materia_id
  LEFT JOIN Instituciones i ON i.id = m.institucion_id
  LEFT JOIN Grupos g ON g.id = a.grupo_id
`;

const stmts = {
  /* ---------- Instituciones ---------- */
  listarInstituciones: stmt(`
    SELECT i.id, i.nombre, i.pdf_titulo, i.pdf_encabezado,
           (SELECT COUNT(*) FROM Materias mm WHERE mm.institucion_id = i.id) AS materias
      FROM Instituciones i
     ORDER BY i.nombre
  `),
  getInstitucion: stmt('SELECT * FROM Instituciones WHERE id = ?'),
  crearInstitucion: stmt('INSERT INTO Instituciones (nombre) VALUES (?)'),
  editarInstitucion: stmt(
    'UPDATE Instituciones SET nombre = ?, pdf_titulo = ?, pdf_encabezado = ? WHERE id = ?'
  ),
  borrarInstitucion: stmt('DELETE FROM Instituciones WHERE id = ?'),
  contarMateriasDeInstitucion: stmt(
    'SELECT COUNT(*) AS n FROM Materias WHERE institucion_id = ?'
  ),

  /* ---------- Materias ---------- */
  listarMaterias: stmt(`
    SELECT m.id, m.nombre, m.institucion_id, i.nombre AS institucion_nombre,
           m.duracion_minutos, m.disponible_desde, m.disponible_hasta, m.profesor,
           (SELECT COUNT(*) FROM Alumnos a WHERE a.materia_id = m.id) AS alumnos,
           (SELECT COUNT(*) FROM Preguntas p WHERE p.materia_id = m.id) AS preguntas
      FROM Materias m
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     ORDER BY i.nombre, m.nombre
  `),
  materiasDeInstitucion: stmt(
    'SELECT id, nombre FROM Materias WHERE institucion_id = ? ORDER BY nombre'
  ),
  getMateria: stmt(`
    SELECT m.*, i.nombre AS institucion_nombre
      FROM Materias m
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     WHERE m.id = ?
  `),
  crearMateria: stmt(`
    INSERT INTO Materias
      (nombre, institucion_id, duracion_minutos, disponible_desde, disponible_hasta, profesor)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  editarMateria: stmt(`
    UPDATE Materias
       SET nombre = ?, duracion_minutos = ?, disponible_desde = ?, disponible_hasta = ?,
           profesor = ?
     WHERE id = ?
  `),
  alumnosDeMateriaConNota: stmt(`
    SELECT a.documento, a.nombre, r.puntaje_total_obtenido, r.estado
      FROM Alumnos a
      LEFT JOIN Respuestas r ON r.documento_alumno = a.documento
     WHERE a.materia_id = ?
  `),
  borrarMateria: stmt('DELETE FROM Materias WHERE id = ?'),
  contarAlumnosDeMateria: stmt('SELECT COUNT(*) AS n FROM Alumnos WHERE materia_id = ?'),
  contarPreguntasDeMateria: stmt('SELECT COUNT(*) AS n FROM Preguntas WHERE materia_id = ?'),

  /* ---------- Alumnos ---------- */
  getAlumno: stmt(`
    SELECT a.*, m.nombre AS materia_nombre, m.institucion_id,
           m.duracion_minutos, m.disponible_desde, m.disponible_hasta,
           i.nombre AS institucion_nombre,
           i.pdf_titulo AS institucion_pdf_titulo,
           i.pdf_encabezado AS institucion_pdf_encabezado,
           g.nombre AS grupo_nombre, g.dia AS grupo_dia,
           g.hora_desde AS grupo_hora_desde, g.hora_hasta AS grupo_hora_hasta
      FROM Alumnos a
      ${JOIN_ALUMNO}
     WHERE a.documento = ?
  `),
  listarAlumnos: stmt(`
    SELECT a.documento, a.nombre, a.email, a.grupo_id, a.materia_id,
           m.nombre AS materia_nombre, i.nombre AS institucion_nombre,
           g.nombre AS grupo_nombre, g.dia AS grupo_dia
      FROM Alumnos a
      ${JOIN_ALUMNO}
     ORDER BY i.nombre, m.nombre, a.nombre
  `),
  crearAlumno: stmt(`
    INSERT INTO Alumnos (documento, nombre, email, grupo_id, materia_id)
    VALUES (?, ?, ?, ?, ?)
  `),
  editarAlumno: stmt(`
    UPDATE Alumnos
       SET nombre = ?, email = ?, grupo_id = ?, materia_id = ?
     WHERE documento = ?
  `),
  borrarAlumno: stmt('DELETE FROM Alumnos WHERE documento = ?'),
  alumnoTieneEntrega: stmt('SELECT 1 FROM Respuestas WHERE documento_alumno = ?'),

  /* ---------- Preguntas ---------- */
  listarPreguntas: stmt(`
    SELECT p.*, m.nombre AS materia_nombre, i.nombre AS institucion_nombre
      FROM Preguntas p
      LEFT JOIN Materias m ON m.id = p.materia_id
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     ORDER BY p.id
  `),
  preguntasDeMateria: stmt('SELECT * FROM Preguntas WHERE materia_id = ? ORDER BY id'),
  getPregunta: stmt('SELECT * FROM Preguntas WHERE id = ?'),
  crearPregunta: stmt(`
    INSERT INTO Preguntas
      (texto, tipo, opciones_json, respuesta_correcta, puntos, obligatoria, materia_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  editarPregunta: stmt(`
    UPDATE Preguntas
       SET texto = ?, tipo = ?, opciones_json = ?, respuesta_correcta = ?,
           puntos = ?, obligatoria = ?, materia_id = ?
     WHERE id = ?
  `),
  borrarPregunta: stmt('DELETE FROM Preguntas WHERE id = ?'),
  maxPuntosDeMateria: stmt('SELECT COALESCE(SUM(puntos), 0) AS n FROM Preguntas WHERE materia_id = ?'),

  /* ---------- Respuestas ---------- */
  getRespuestaByAlumno: stmt('SELECT * FROM Respuestas WHERE documento_alumno = ?'),
  getRespuestaById: stmt('SELECT * FROM Respuestas WHERE id = ?'),
  insertarRespuesta: stmt(`
    INSERT INTO Respuestas
      (documento_alumno, nombre_alumno, materia_id, respuestas_json, puntaje_choice,
       puntaje_desarrollo, puntaje_total_obtenido, timestamp_entrega,
       abandonos_count, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  calificarDesarrollo: stmt(`
    UPDATE Respuestas
       SET puntaje_desarrollo = ?,
           puntaje_total_obtenido = puntaje_choice + ?
     WHERE id = ?
  `),
  guardarDevoluciones: stmt('UPDATE Respuestas SET devoluciones = ? WHERE id = ?'),
  guardarCorreccion: stmt(`
    UPDATE Respuestas
       SET puntaje_desarrollo = ?,
           puntaje_total_obtenido = puntaje_choice + ?,
           devoluciones = ?,
           devoluciones_json = ?,
           puntajes_json = ?
     WHERE id = ?
  `),
  marcarPdfEnviado: stmt('UPDATE Respuestas SET pdf_enviado = 1 WHERE id = ?'),
  marcarCorregido: stmt('UPDATE Respuestas SET corregido = 1 WHERE id = ?'),
  alumnosConEntrega: stmt(`
    SELECT a.documento,
           a.nombre,
           a.email,
           a.grupo_id,
           a.materia_id,
           m.nombre AS materia_nombre,
           i.id     AS institucion_id,
           i.nombre AS institucion_nombre,
           g.nombre AS grupo_nombre,
           g.dia    AS grupo_dia,
           r.id                AS respuesta_id,
           r.timestamp_entrega,
           r.abandonos_count,
           r.estado,
           r.corregido,
           r.puntaje_choice,
           r.puntaje_desarrollo,
           r.puntaje_total_obtenido,
           r.puntajes_json,
           r.devoluciones,
           r.pdf_enviado,
           r.pdf_titulo,
           r.pdf_encabezado
      FROM Alumnos a
      ${JOIN_ALUMNO}
      LEFT JOIN Respuestas r ON r.documento_alumno = a.documento
     ORDER BY i.nombre, m.nombre, a.nombre
  `),

  /* ---------- Grupos ---------- */
  listarGrupos: stmt(`
    SELECT g.*,
           (SELECT COUNT(*) FROM Alumnos a WHERE a.grupo_id = g.id) AS alumnos
      FROM Grupos g
     ORDER BY g.dia, g.hora_desde
  `),
  getGrupo: stmt('SELECT * FROM Grupos WHERE id = ?'),
  crearGrupo: stmt(`
    INSERT INTO Grupos (nombre, dia, hora_desde, hora_hasta)
    VALUES (?, ?, ?, ?)
  `),
  editarGrupo: stmt(`
    UPDATE Grupos
       SET nombre = ?, dia = ?, hora_desde = ?, hora_hasta = ?
     WHERE id = ?
  `),
  borrarGrupo: stmt('DELETE FROM Grupos WHERE id = ?'),
  contarAlumnosDeGrupo: stmt('SELECT COUNT(*) AS n FROM Alumnos WHERE grupo_id = ?')
};

/**
 * Borra una materia con su estructura (preguntas y alumnos).
 * Las entregas ya hechas se conservan como historial, sin materia asignada.
 */
async function borrarMateriaEnCascada(id) {
  await client.batch(
    [
      { sql: 'UPDATE Respuestas SET materia_id = NULL WHERE materia_id = ?', args: [id] },
      { sql: 'DELETE FROM Preguntas WHERE materia_id = ?', args: [id] },
      { sql: 'DELETE FROM Alumnos WHERE materia_id = ?', args: [id] },
      { sql: 'DELETE FROM Materias WHERE id = ?', args: [id] }
    ],
    'write'
  );
}

/**
 * Borra una institucion con sus materias, preguntas y alumnos.
 * Las entregas se conservan como historial, sin materia asignada.
 */
async function borrarInstitucionEnCascada(id) {
  const materias = await all('SELECT id FROM Materias WHERE institucion_id = ?', [id]);
  const sentencias = [];
  for (const m of materias) {
    sentencias.push(
      { sql: 'UPDATE Respuestas SET materia_id = NULL WHERE materia_id = ?', args: [m.id] },
      { sql: 'DELETE FROM Preguntas WHERE materia_id = ?', args: [m.id] },
      { sql: 'DELETE FROM Alumnos WHERE materia_id = ?', args: [m.id] }
    );
  }
  sentencias.push(
    { sql: 'DELETE FROM Materias WHERE institucion_id = ?', args: [id] },
    { sql: 'DELETE FROM Instituciones WHERE id = ?', args: [id] }
  );
  await client.batch(sentencias, 'write');
}

/** Se resuelve cuando el esquema esta listo (se espera en cada request). */
const ready = initSchema();

module.exports = {
  client,
  stmts,
  ready,
  all,
  one,
  run,
  borrarMateriaEnCascada,
  borrarInstitucionEnCascada,
  DB_PATH
};
