'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function columnas(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}

function existeTabla(nombre) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(nombre);
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Instituciones (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS Materias (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT NOT NULL,
      institucion_id INTEGER REFERENCES Instituciones(id)
    );

    CREATE TABLE IF NOT EXISTS Alumnos (
      documento  TEXT PRIMARY KEY,
      nombre     TEXT NOT NULL,
      email      TEXT NOT NULL,
      materia_id INTEGER REFERENCES Materias(id),
      grupo_id   INTEGER REFERENCES Grupos(id)
    );

    CREATE TABLE IF NOT EXISTS Preguntas (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      texto              TEXT NOT NULL,
      tipo               TEXT NOT NULL DEFAULT 'desarrollo' CHECK (tipo IN ('choice','desarrollo')),
      opciones_json      TEXT,
      respuesta_correcta TEXT,
      puntos             INTEGER NOT NULL DEFAULT 1,
      materia_id         INTEGER REFERENCES Materias(id)
    );

    CREATE TABLE IF NOT EXISTS Respuestas (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_alumno       TEXT NOT NULL,
      nombre_alumno          TEXT NOT NULL,
      materia_id             INTEGER REFERENCES Materias(id),
      respuestas_json        TEXT NOT NULL,
      puntaje_choice         INTEGER NOT NULL DEFAULT 0,
      puntaje_desarrollo     INTEGER NOT NULL DEFAULT 0,
      puntaje_total_obtenido INTEGER NOT NULL DEFAULT 0,
      timestamp_entrega      TEXT NOT NULL,
      abandonos_count        INTEGER NOT NULL DEFAULT 0,
      estado                 TEXT NOT NULL CHECK (estado IN ('entregado','expulsado')),
      devoluciones           TEXT,
      pdf_enviado            INTEGER NOT NULL DEFAULT 0,
      pdf_titulo             TEXT,
      pdf_encabezado         TEXT,
      UNIQUE (documento_alumno)
    );

    CREATE TABLE IF NOT EXISTS Grupos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL UNIQUE,
      dia        INTEGER NOT NULL CHECK (dia BETWEEN 0 AND 6),
      hora_desde TEXT NOT NULL,
      hora_hasta TEXT NOT NULL
    );
  `);

  migrarEsquemaViejo();
  migrarGrupos();
  asegurarGeneral();
}

/** Migra bases creadas con el esquema anterior (codigo -> documento, +materia_id). */
function migrarEsquemaViejo() {
  if (existeTabla('Alumnos')) {
    const c = columnas('Alumnos');
    if (c.includes('codigo') && !c.includes('documento')) {
      db.exec('ALTER TABLE Alumnos RENAME COLUMN codigo TO documento');
    }
    if (!columnas('Alumnos').includes('materia_id')) {
      db.exec('ALTER TABLE Alumnos ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
    }
  }

  if (existeTabla('Respuestas')) {
    const c = columnas('Respuestas');
    if (c.includes('codigo_alumno') && !c.includes('documento_alumno')) {
      db.exec('ALTER TABLE Respuestas RENAME COLUMN codigo_alumno TO documento_alumno');
    }
    if (!columnas('Respuestas').includes('materia_id')) {
      db.exec('ALTER TABLE Respuestas ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
    }
    if (!columnas('Respuestas').includes('devoluciones')) {
      db.exec('ALTER TABLE Respuestas ADD COLUMN devoluciones TEXT');
    }
    if (!columnas('Respuestas').includes('pdf_enviado')) {
      db.exec('ALTER TABLE Respuestas ADD COLUMN pdf_enviado INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnas('Respuestas').includes('pdf_titulo')) {
      db.exec('ALTER TABLE Respuestas ADD COLUMN pdf_titulo TEXT');
    }
    if (!columnas('Respuestas').includes('pdf_encabezado')) {
      db.exec('ALTER TABLE Respuestas ADD COLUMN pdf_encabezado TEXT');
    }
  }

  if (existeTabla('Preguntas') && !columnas('Preguntas').includes('materia_id')) {
    db.exec('ALTER TABLE Preguntas ADD COLUMN materia_id INTEGER REFERENCES Materias(id)');
  }
}

/**
 * Migracion de grupos: antes era un CHECK ('sabado','lunes') en Alumnos.grupo_dia.
 * Ahora tabla Grupos (nombre, dia 0-6, hora_desde, hora_hasta) y Alumnos.grupo_id.
 * Crea los grupos por defecto si la tabla esta vacia y migra las filas existentes.
 */
function migrarGrupos() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Grupos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL UNIQUE,
      dia        INTEGER NOT NULL CHECK (dia BETWEEN 0 AND 6),
      hora_desde TEXT NOT NULL,
      hora_hasta TEXT NOT NULL
    );
  `);

  const hayGrupos = db.prepare('SELECT COUNT(*) AS n FROM Grupos').get().n;
  if (hayGrupos === 0) {
    const ins = db.prepare(
      'INSERT INTO Grupos (nombre, dia, hora_desde, hora_hasta) VALUES (?, ?, ?, ?)'
    );
    ins.run('Sabado', 6, '10:00', '14:00');
    ins.run('Lunes', 1, '14:00', '18:00');
  }

  if (!existeTabla('Alumnos')) return;
  const c = columnas('Alumnos');
  if (!c.includes('grupo_dia')) return; // ya migrado (o base nueva sin legacy)

  if (!c.includes('grupo_id')) {
    db.exec('ALTER TABLE Alumnos ADD COLUMN grupo_id INTEGER REFERENCES Grupos(id)');
  }

  // Backfill: mapea los valores viejos 'sabado'/'lunes' a los grupos por defecto.
  const gSab = db.prepare('SELECT id FROM Grupos WHERE nombre = ?').get('Sabado');
  const gLun = db.prepare('SELECT id FROM Grupos WHERE nombre = ?').get('Lunes');
  if (gSab) {
    db.prepare('UPDATE Alumnos SET grupo_id = ? WHERE grupo_dia = ? AND grupo_id IS NULL').run(
      gSab.id,
      'sabado'
    );
  }
  if (gLun) {
    db.prepare('UPDATE Alumnos SET grupo_id = ? WHERE grupo_dia = ? AND grupo_id IS NULL').run(
      gLun.id,
      'lunes'
    );
  }
  // Filas sin coincidencia caen al primer grupo disponible.
  const primero = db.prepare('SELECT id FROM Grupos ORDER BY id LIMIT 1').get();
  if (primero) {
    db.prepare('UPDATE Alumnos SET grupo_id = ? WHERE grupo_id IS NULL').run(primero.id);
  }

  db.exec('ALTER TABLE Alumnos DROP COLUMN grupo_dia');
}

/**
 * Si quedaron filas sin materia_id (esquema anterior), crea
 * institucion/materia "General" y las asigna. En bases nuevas no hace nada.
 */
function asegurarGeneral() {
  const sinMateria = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM Alumnos WHERE materia_id IS NULL) +
         (SELECT COUNT(*) FROM Preguntas WHERE materia_id IS NULL) +
         (SELECT COUNT(*) FROM Respuestas WHERE materia_id IS NULL) AS n`
    )
    .get().n;
  if (sinMateria === 0) return;

  const inst = db.prepare('SELECT id FROM Instituciones WHERE nombre = ?').get('General');
  const instId =
    inst?.id ||
    db.prepare('INSERT INTO Instituciones (nombre) VALUES (?)').run('General').lastInsertRowid;

  const mat = db
    .prepare('SELECT id FROM Materias WHERE institucion_id = ? AND nombre = ?')
    .get(instId, 'General');
  const matId =
    mat?.id ||
    db
      .prepare('INSERT INTO Materias (nombre, institucion_id) VALUES (?, ?)')
      .run('General', instId).lastInsertRowid;

  db.prepare('UPDATE Alumnos SET materia_id = ? WHERE materia_id IS NULL').run(matId);
  db.prepare('UPDATE Preguntas SET materia_id = ? WHERE materia_id IS NULL').run(matId);
  db.prepare(
    `UPDATE Respuestas SET materia_id = COALESCE(
       materia_id,
       (SELECT materia_id FROM Alumnos WHERE documento = documento_alumno),
       ?
     )
     WHERE materia_id IS NULL`
  ).run(matId);
}

initSchema();

const JOIN_ALUMNO = `
  LEFT JOIN Materias m ON m.id = a.materia_id
  LEFT JOIN Instituciones i ON i.id = m.institucion_id
  LEFT JOIN Grupos g ON g.id = a.grupo_id
`;

const stmts = {
  /* ---------- Instituciones ---------- */
  listarInstituciones: db.prepare(`
    SELECT i.id, i.nombre,
           (SELECT COUNT(*) FROM Materias mm WHERE mm.institucion_id = i.id) AS materias
      FROM Instituciones i
     ORDER BY i.nombre
  `),
  getInstitucion: db.prepare('SELECT * FROM Instituciones WHERE id = ?'),
  crearInstitucion: db.prepare('INSERT INTO Instituciones (nombre) VALUES (?)'),
  editarInstitucion: db.prepare('UPDATE Instituciones SET nombre = ? WHERE id = ?'),
  borrarInstitucion: db.prepare('DELETE FROM Instituciones WHERE id = ?'),
  contarMateriasDeInstitucion: db.prepare(
    'SELECT COUNT(*) AS n FROM Materias WHERE institucion_id = ?'
  ),

  /* ---------- Materias ---------- */
  listarMaterias: db.prepare(`
    SELECT m.id, m.nombre, m.institucion_id, i.nombre AS institucion_nombre,
           (SELECT COUNT(*) FROM Alumnos a WHERE a.materia_id = m.id) AS alumnos,
           (SELECT COUNT(*) FROM Preguntas p WHERE p.materia_id = m.id) AS preguntas
      FROM Materias m
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     ORDER BY i.nombre, m.nombre
  `),
  materiasDeInstitucion: db.prepare(
    'SELECT id, nombre FROM Materias WHERE institucion_id = ? ORDER BY nombre'
  ),
  getMateria: db.prepare(`
    SELECT m.*, i.nombre AS institucion_nombre
      FROM Materias m
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     WHERE m.id = ?
  `),
  crearMateria: db.prepare('INSERT INTO Materias (nombre, institucion_id) VALUES (?, ?)'),
  editarMateria: db.prepare('UPDATE Materias SET nombre = ? WHERE id = ?'),
  borrarMateria: db.prepare('DELETE FROM Materias WHERE id = ?'),
  contarAlumnosDeMateria: db.prepare(
    'SELECT COUNT(*) AS n FROM Alumnos WHERE materia_id = ?'
  ),
  contarPreguntasDeMateria: db.prepare(
    'SELECT COUNT(*) AS n FROM Preguntas WHERE materia_id = ?'
  ),

  /* ---------- Alumnos ---------- */
  getAlumno: db.prepare(`
    SELECT a.*, m.nombre AS materia_nombre, m.institucion_id,
           i.nombre AS institucion_nombre,
           g.nombre AS grupo_nombre, g.dia AS grupo_dia,
           g.hora_desde AS grupo_hora_desde, g.hora_hasta AS grupo_hora_hasta
      FROM Alumnos a
      ${JOIN_ALUMNO}
     WHERE a.documento = ?
  `),
  listarAlumnos: db.prepare(`
    SELECT a.documento, a.nombre, a.email, a.grupo_id, a.materia_id,
           m.nombre AS materia_nombre, i.nombre AS institucion_nombre,
           g.nombre AS grupo_nombre, g.dia AS grupo_dia
      FROM Alumnos a
      ${JOIN_ALUMNO}
     ORDER BY i.nombre, m.nombre, a.nombre
  `),
  crearAlumno: db.prepare(`
    INSERT INTO Alumnos (documento, nombre, email, grupo_id, materia_id)
    VALUES (@documento, @nombre, @email, @grupo_id, @materia_id)
  `),
  editarAlumno: db.prepare(`
    UPDATE Alumnos
       SET nombre = @nombre, email = @email, grupo_id = @grupo_id,
           materia_id = @materia_id
     WHERE documento = @documento
  `),
  borrarAlumno: db.prepare('DELETE FROM Alumnos WHERE documento = ?'),
  alumnoTieneEntrega: db.prepare(
    'SELECT 1 FROM Respuestas WHERE documento_alumno = ?'
  ),

  /* ---------- Preguntas ---------- */
  listarPreguntas: db.prepare(`
    SELECT p.*, m.nombre AS materia_nombre, i.nombre AS institucion_nombre
      FROM Preguntas p
      LEFT JOIN Materias m ON m.id = p.materia_id
      LEFT JOIN Instituciones i ON i.id = m.institucion_id
     ORDER BY p.id
  `),
  preguntasDeMateria: db.prepare(
    'SELECT * FROM Preguntas WHERE materia_id = ? ORDER BY id'
  ),
  getPregunta: db.prepare('SELECT * FROM Preguntas WHERE id = ?'),
  crearPregunta: db.prepare(`
    INSERT INTO Preguntas (texto, tipo, opciones_json, respuesta_correcta, puntos, materia_id)
    VALUES (@texto, @tipo, @opciones_json, @respuesta_correcta, @puntos, @materia_id)
  `),
  editarPregunta: db.prepare(`
    UPDATE Preguntas
       SET texto = @texto, tipo = @tipo, opciones_json = @opciones_json,
           respuesta_correcta = @respuesta_correcta, puntos = @puntos,
           materia_id = @materia_id
     WHERE id = @id
  `),
  borrarPregunta: db.prepare('DELETE FROM Preguntas WHERE id = ?'),
  maxPuntosDeMateria: db.prepare(
    'SELECT COALESCE(SUM(puntos), 0) AS n FROM Preguntas WHERE materia_id = ?'
  ),

  /* ---------- Respuestas ---------- */
  getRespuestaByAlumno: db.prepare(
    'SELECT * FROM Respuestas WHERE documento_alumno = ?'
  ),
  getRespuestaById: db.prepare('SELECT * FROM Respuestas WHERE id = ?'),
  insertarRespuesta: db.prepare(`
    INSERT INTO Respuestas
      (documento_alumno, nombre_alumno, materia_id, respuestas_json, puntaje_choice,
       puntaje_desarrollo, puntaje_total_obtenido, timestamp_entrega,
       abandonos_count, estado)
    VALUES (@documento_alumno, @nombre_alumno, @materia_id, @respuestas_json, @puntaje_choice,
            @puntaje_desarrollo, @puntaje_total_obtenido, @timestamp_entrega,
            @abandonos_count, @estado)
  `),
  calificarDesarrollo: db.prepare(`
    UPDATE Respuestas
       SET puntaje_desarrollo = ?,
           puntaje_total_obtenido = puntaje_choice + ?
     WHERE id = ?
  `),
  guardarDevoluciones: db.prepare(`
    UPDATE Respuestas
       SET devoluciones = ?
     WHERE id = ?
  `),
  guardarEncabezadoPdf: db.prepare(`
    UPDATE Respuestas
       SET pdf_titulo = ?, pdf_encabezado = ?
     WHERE id = ?
  `),
  marcarPdfEnviado: db.prepare(`
    UPDATE Respuestas SET pdf_enviado = 1 WHERE id = ?
  `),
  alumnosConEntrega: db.prepare(`
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
           r.puntaje_choice,
           r.puntaje_desarrollo,
           r.puntaje_total_obtenido,
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
  listarGrupos: db.prepare(`
    SELECT g.*,
           (SELECT COUNT(*) FROM Alumnos a WHERE a.grupo_id = g.id) AS alumnos
      FROM Grupos g
     ORDER BY g.dia, g.hora_desde
  `),
  getGrupo: db.prepare('SELECT * FROM Grupos WHERE id = ?'),
  crearGrupo: db.prepare(`
    INSERT INTO Grupos (nombre, dia, hora_desde, hora_hasta)
    VALUES (@nombre, @dia, @hora_desde, @hora_hasta)
  `),
  editarGrupo: db.prepare(`
    UPDATE Grupos
       SET nombre = @nombre, dia = @dia, hora_desde = @hora_desde,
           hora_hasta = @hora_hasta
     WHERE id = @id
  `),
  borrarGrupo: db.prepare('DELETE FROM Grupos WHERE id = ?'),
  contarAlumnosDeGrupo: db.prepare(
    'SELECT COUNT(*) AS n FROM Alumnos WHERE grupo_id = ?'
  )
};

module.exports = { db, stmts, DB_PATH };
