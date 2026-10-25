'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const {
  stmtsExamenes,
  stmts,
  ready,
  borrarMateriaEnCascada,
  borrarInstitucionEnCascada
} = require('./lib/db');
const { LibsqlStore } = require('./lib/session-store');
const { getProfesor, setProfesor, verificarClave, cambiarClave } = require('./lib/cuenta');
const {
  validarHorario,
  ventanaDe,
  ventanaExamen,
  etiquetaVentana,
  duracionExamenMs,
  minutosHastaVentana
} = require('./lib/horarios');
const { evaluarChoice } = require('./lib/grading');
const { generarPdf, generarPlanillaPdf } = require('./lib/pdf');
const { enviarPdf } = require('./lib/mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const GRACIA_ENTREGA_MS = 10 * 60 * 1000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '80mb' }));
// sin cache: siempre revalida con ETag (evita JS/CSS viejos cacheados)
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.use(
  session({
    name: 'examen.sid',
    secret: process.env.SESSION_SECRET || 'examen-secret-cambiar-en-produccion',
    store: new LibsqlStore({ ttl: 4 * 60 * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 4 * 60 * 60 * 1000 }
  })
);

// En serverless el esquema se crea en el primer request de cada instancia.
app.use(async (req, res, next) => {
  try {
    await ready;
    next();
  } catch (err) {
    next(err);
  }
});

const TZ = 'America/Argentina/Salta';
const fmtTs = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

function tsServidor(d = new Date()) {
  const p = fmtTs.formatToParts(d).reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

/** Puntaje con hasta 2 decimales (acepta coma o punto). */
function puntaje(n) {
  const v = Number(String(n == null ? '' : n).replace(',', '.'));
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(0, v) * 100) / 100;
}

/** 'YYYY-MM-DD HH:MM:SS' -> 'dd/mm/aaaa - hh:mm' (zona America/Argentina/Salta). */
function fechaCorta(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} - ${m[4]}:${m[5]}` : '—';
}

function requiereAlumno(req, res, next) {
  if (!req.session.alumno) {
    if (req.path.startsWith('/api/') || req.path === '/entregar') {
      return res.status(401).json({ ok: false, error: 'Sesión no válida.' });
    }
    return res.redirect('/');
  }
  next();
}

/** Para la vista del examen: si ya entrego, no vuelve a entrar. */
async function bloqueaSiYaEntrego(req, res, next) {
  const entrega = await stmts.getRespuestaByAlumnoExamen.get(req.session.alumno.documento, req.session.examen_id);
  if (entrega) {
    return renderLogin(res, {
      error: 'Ya entregaste tu examen. Solo se permite un único intento.',
      documento: req.session.alumno.documento
    });
  }
  next();
}

/** Renderiza la vista login con los grupos actuales (horarios). */
async function renderLogin(res, data) {
  const grupos = await stmts.listarGrupos.all();
  return res.render('login', { grupos, ...data });
}

function requiereAdmin(req, res, next) {
  if (req.session.admin) return next();
  return res.redirect('/admin');
}

/* ------------------------------------------------------------------ */
/*  PUBLICO: acceso + horarios                                         */
/* ------------------------------------------------------------------ */

app.get('/', async (req, res) => {
  if (req.session.alumno) return res.redirect('/examen');
  await renderLogin(res, { error: null, documento: '' });
});

app.post('/login', async (req, res) => {
  const documento = String(req.body.documento || '').trim();
  if (!documento) {
    return renderLogin(res, { error: 'Ingresa tu Número de Documento.', documento: '' });
  }

  const alumno = await stmts.getAlumno.get(documento);
  if (!alumno) {
    return renderLogin(res, {
      error: 'Documento inexistente. Verifica con tu profesor.',
      documento
    });
  }

  const entrega = await stmts.getRespuestaByAlumno.get(documento);
  if (entrega) {
    return renderLogin(res, {
      error: 'Ya entregaste tu examen. Solo se permite un único intento.',
      documento
    });
  }

  // 1) Solo se puede ingresar en el dia y horario habilitados para el grupo.
  const horario = await validarHorario(alumno.grupo_id);
  if (!horario.ok) {
    return renderLogin(res, { error: horario.motivo, documento });
  }

  // 2) Si la materia ademas define una ventana de fechas, tambien debe estar abierta.
  const ventanaMateria = ventanaExamen(alumno, tsServidor());
  if (ventanaMateria && !ventanaMateria.ok) {
    return renderLogin(res, { error: ventanaMateria.motivo, documento });
  }

  // 3) Examen asignado al alumno (publicado, no archivado, de su materia)
  const examenAlumno = await stmtsExamenes.examenesDelAlumno.get(documento);
  if (!examenAlumno) {
    return renderLogin(res, { error: 'No tienes un examen asignado. Consulta con tu profesor.', documento });
  }

  const inicio = Date.now();
  // Tiempo de resolucion propio del examen, recortado si la ventana cierra antes.
  const minutosVentana = minutosHastaVentana(alumno, tsServidor());
  const fin =
    minutosVentana == null
      ? inicio + duracionExamenMs(alumno)
      : Math.min(inicio + duracionExamenMs(alumno), inicio + minutosVentana * 60000);

  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Error de sesion.');
    req.session.alumno = { documento: alumno.documento, nombre: alumno.nombre };
    req.session.examen_id = examenAlumno.id;
    req.session.inicio = inicio;
    req.session.fin = fin;
    req.session.abandonos = 0;
    res.redirect('/examen');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ------------------------------------------------------------------ */
/*  EXAMEN                                                             */
/* ------------------------------------------------------------------ */

app.get('/examen', requiereAlumno, bloqueaSiYaEntrego, async (req, res) => {
  const alumno = await stmts.getAlumno.get(req.session.alumno.documento);
  const examenId = req.session.examen_id;
  const preguntas = examenId ? await stmtsExamenes.preguntasDeExamen.all(examenId) : [];

  const enRango = req.session.fin - Date.now();
  const restante = Math.max(0, Math.min(duracionExamenMs(alumno), enRango));

  const ventanaFechas = etiquetaVentana(alumno);
  const ventanaGrupo = `del grupo ${await ventanaDe(alumno.grupo_id)}`;
  res.render('examen', {
    alumno,
    preguntas,
    restanteMs: restante,
    serverNow: Date.now(),
    duracionMinutos: Math.max(1, Math.round(duracionExamenMs(alumno) / 60000)),
    ventana: ventanaFechas ? `${ventanaFechas} (${ventanaGrupo})` : ventanaGrupo
  });
});

app.get('/api/tiempo', (req, res) => {
  if (!req.session.alumno) return res.status(401).json({ error: 'no-session' });
  const restante = Math.max(0, req.session.fin - Date.now());
  res.json({ restante, serverNow: Date.now(), expirado: restante <= 0 });
});

app.post('/api/abandono', (req, res) => {
  if (!req.session.alumno) return res.status(401).json({ error: 'no-session' });
  if (typeof req.session.abandonos !== 'number') req.session.abandonos = 0;
  if (req.session.abandonos < 3) req.session.abandonos += 1;
  res.json({ abandonos: req.session.abandonos, expulsado: req.session.abandonos >= 3 });
});

/**
 * Entrega del examen.
 * body: { respuestas: { [preguntaId]: valor }, estado?: 'expulsado' | 'entregado' }
 */
app.post('/entregar', requiereAlumno, async (req, res) => {
  const documento = req.session.alumno.documento;
  const examenId = req.session.examen_id;
  const alumno = await stmts.getAlumno.get(documento);

  if (await stmts.getRespuestaByAlumnoExamen.get(documento, examenId)) {
    return res.status(409).json({ ok: false, error: 'Ya entregaste tu examen.' });
  }

  const ahora = Date.now();
  const abandonos = typeof req.session.abandonos === 'number' ? req.session.abandonos : 0;
  const expulsado = req.body && req.body.estado === 'expulsado';
  const expirado = ahora > req.session.fin + GRACIA_ENTREGA_MS;

  if (!expulsado && expirado) {
    return res.status(410).json({
      ok: false,
      error: 'El tiempo del examen expiro. Consulta con tu profesor.'
    });
  }

  const bruto = (req.body && req.body.respuestas) || {};
  const respuestas = {};
  for (const k of Object.keys(bruto)) {
    const n = Number(k);
    if (Number.isInteger(n)) respuestas[n] = bruto[k];
  }

  const preguntas = await stmtsExamenes.preguntasDeExamen.all(examenId);

  // Mientras quede tiempo, no se puede entregar sin responder las obligatorias.
  if (!expulsado && ahora <= req.session.fin) {
    const sinResponder = preguntas.filter((p) => {
      if (!Number(p.obligatoria)) return false;
      const v = respuestas[p.id];
      if (v == null) return true;
      if (Array.isArray(v)) return v.length === 0;
      return String(v).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
    });
    if (sinResponder.length > 0) {
      return res.status(400).json({
        ok: false,
        error:
          sinResponder.length === 1
            ? 'Falta responder 1 pregunta obligatoria.'
            : `Faltan responder ${sinResponder.length} preguntas obligatorias.`,
        faltantes: sinResponder.map((p) => p.id)
      });
    }
  }

  const { choice } = evaluarChoice(preguntas, respuestas);

  const timestamp = tsServidor();
  const estado = expulsado ? 'expulsado' : 'entregado';

  const fila = {
    documento_alumno: documento,
    nombre_alumno: alumno.nombre,
    materia_id: alumno.materia_id || null,
    examen_id: examenId,
    respuestas_json: JSON.stringify(respuestas),
    puntaje_choice: choice,
    puntaje_desarrollo: 0,
    puntaje_total_obtenido: choice,
    timestamp_entrega: timestamp,
    abandonos_count: abandonos,
    estado
  };

  try {
    await stmts.insertarRespuesta.run(
      fila.documento_alumno,
      fila.nombre_alumno,
      fila.materia_id,
      fila.examen_id,
      fila.respuestas_json,
      fila.puntaje_choice,
      fila.puntaje_desarrollo,
      fila.puntaje_total_obtenido,
      fila.timestamp_entrega,
      fila.abandonos_count,
      fila.estado
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'Ya entregaste tu examen.' });
    }
    console.error('[entregar] sqlite:', e);
    return res.status(500).json({ ok: false, error: 'Error al guardar.' });
  }

  const entrega = await stmts.getRespuestaByAlumnoExamen.get(documento, examenId);

  // El temporizador/avisos de la sesion ya no sirven.
  delete req.session.fin;
  req.session.entregado = true;

  // El PDF NO se genera ni se envia aqui: recien cuando el profesor corrige
  // (evita duplicacion de examenes/correos).
  res.json({
    ok: true,
    estado,
    puntaje_choice: choice,
    puntaje_total: entrega.puntaje_total_obtenido,
    correo: null
  });
});

/**
 * Genera PDF y envia por Gmail. Nunca revierte la entrega.
 */
async function generarYEnviar({ alumno, entrega, preguntas, respuestas, puntuacion, devoluciones }) {
  const out = { pdf: null, correo: null };
  try {
    const { filePath } = await generarPdf({
      alumno,
      entrega,
      preguntas,
      respuestas,
      puntuacion,
      devoluciones
    });
    out.pdf = filePath;
    const mail = await enviarPdf({
      email: alumno.email,
      nombre: alumno.nombre,
      documento: alumno.documento,
      pdfPath: filePath,
      asuntoExtra: `Examen ${entrega.estado} - ${alumno.nombre} (${alumno.documento})`
    });
    out.correo = mail;
    if (!mail.ok) console.warn('[correo] fallo:', mail.error);
  } catch (e) {
    console.error('[pdf/correo]', e);
    out.error = e.message;
  }
  return out;
}

async function prepararDatosPdf(respuestaId) {
  const entrega = await stmts.getRespuestaById.get(respuestaId);
  if (!entrega) return null;
  const alumno =
    (await stmts.getAlumno.get(entrega.documento_alumno)) ||
    { documento: entrega.documento_alumno, nombre: entrega.nombre_alumno, email: '', grupo_id: 0 };
  let respuestas = {};
  try { respuestas = JSON.parse(entrega.respuestas_json || '{}'); } catch { /* noop */ }
  const preguntas = await stmts.preguntasDeMateria.all(entrega.materia_id || 0);

  // Puntaje por pregunta (choice automatico, desarrollo manual) y devoluciones.
  const { detalle } = evaluarChoice(preguntas, respuestas);
  const choicePorId = new Map(detalle.map((d) => [d.id, d.obtenidos]));
  let notas = {};
  let devs = {};
  try { notas = JSON.parse(entrega.puntajes_json || '{}'); } catch { /* noop */ }
  try { devs = JSON.parse(entrega.devoluciones_json || '{}'); } catch { /* noop */ }

  const puntuacion = preguntas.map((p) => ({
    id: p.id,
    tipo: p.tipo,
    max: Number(p.puntos) || 0,
    obtenido:
      p.tipo === 'choice'
        ? choicePorId.get(p.id) || 0
        : notas[p.id] == null
          ? null
          : puntaje(notas[p.id])
  }));

  return { alumno, entrega, preguntas, respuestas, puntuacion, devoluciones: devs };
}

/* ------------------------------------------------------------------ */
/*  ADMIN                                                              */
/* ------------------------------------------------------------------ */

app.get('/admin', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/panel');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const pass = String(req.body.password || '');
  if (!(await verificarClave(pass))) {
    return res.render('admin/login', { error: 'Contrasena incorrecta.' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Error de sesion.');
    req.session.admin = true;
    res.redirect('/admin/panel');
  });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.get('/admin/panel', requiereAdmin, async (req, res) => {
  const alumnos = await stmts.alumnosConEntrega.all();
  const preguntas = await stmts.listarPreguntas.all();
  const maxPuntos = preguntas.reduce((a, p) => a + (Number(p.puntos) || 0), 0);
  res.render('admin/panel', {
    alumnos,
    preguntas,
    maxPuntos,
    hoy: tsServidor(),
    profesor: await getProfesor(),
    ok: req.query.ok || null,
    error: req.query.error || null,
    instituciones: await stmts.listarInstituciones.all(),
    materias: await stmts.listarMaterias.all()
  });
});

/* --------- Cuenta del panel: profesor y clave --------- */

app.post('/admin/cuenta/profesor', requiereAdmin, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const apellido = String(req.body.apellido || '').trim();
    if (!nombre && !apellido) throw new Error('Completa el nombre y el apellido del profesor.');
    if (nombre.length > 60 || apellido.length > 60) {
      throw new Error('Nombre o apellido demasiado largos (max 60).');
    }
    await setProfesor(nombre, apellido);
    res.redirect('/admin/panel?ok=Datos+del+profesor+guardados&cuenta=1');
  } catch (e) {
    res.redirect(`/admin/panel?error=${encodeURIComponent(e.message)}&cuenta=1`);
  }
});

app.post('/admin/cuenta/password', requiereAdmin, async (req, res) => {
  try {
    const actual = String(req.body.actual || '');
    const nueva = String(req.body.nueva || '');
    const repetir = String(req.body.repetir || '');

    if (!(await verificarClave(actual))) throw new Error('La clave actual no es correcta.');
    if (nueva.length < 6) throw new Error('La clave nueva debe tener al menos 6 caracteres.');
    if (nueva !== repetir) throw new Error('La clave nueva y su repeticion no coinciden.');

    await cambiarClave(nueva);
    res.redirect('/admin/panel?ok=Clave+actualizada&cuenta=1');
  } catch (e) {
    res.redirect(`/admin/panel?error=${encodeURIComponent(e.message)}&cuenta=1`);
  }
});

app.get('/admin/api/entregas', requiereAdmin, async (req, res) => {
  res.json({
    ahora: Date.now(),
    alumnos: await stmts.alumnosConEntrega.all(),
    maxPuntos: (await stmts.listarPreguntas.all()).reduce((a, p) => a + (Number(p.puntos) || 0), 0),
    materias: await stmts.listarMaterias.all(),
    instituciones: await stmts.listarInstituciones.all()
  });
});

app.get('/admin/api/alumnos', requiereAdmin, async (req, res) => {
  res.json({ alumnos: await stmts.listarAlumnos.all() });
});

app.get('/admin/api/materias', requiereAdmin, async (req, res) => {
  const instId = Number(req.query.institucion) || 0;
  const lista = instId
    ? await stmts.materiasDeInstitucion.all(instId)
    : await stmts.listarMaterias.all();
  res.json({ materias: lista });
});

/** Entrega completa de un alumno para corregir en el panel. */
app.get('/admin/api/entrega/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const datos = await prepararDatosPdf(id);
  if (!datos) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });

  const notas = {};
  try { Object.assign(notas, JSON.parse(datos.entrega.puntajes_json || '{}')); } catch { /* noop */ }
  const choicePorId = {};
  datos.puntuacion.forEach((p) => {
    if (p.tipo === 'choice') choicePorId[p.id] = p.obtenido;
  });

  res.json({
    ok: true,
    entrega: {
      id: datos.entrega.id,
      estado: datos.entrega.estado,
      corregido: Number(datos.entrega.corregido) || 0,
      timestamp_entrega: datos.entrega.timestamp_entrega,
      abandonos_count: datos.entrega.abandonos_count,
      puntaje_choice: datos.entrega.puntaje_choice,
      puntaje_desarrollo: datos.entrega.puntaje_desarrollo,
      puntaje_total_obtenido: datos.entrega.puntaje_total_obtenido,
      pdf_enviado: Number(datos.entrega.pdf_enviado) || 0
    },
    alumno: {
      documento: datos.alumno.documento,
      nombre: datos.alumno.nombre,
      email: datos.alumno.email || '',
      materia_nombre: datos.alumno.materia_nombre,
      institucion_nombre: datos.alumno.institucion_nombre
    },
    preguntas: datos.preguntas.map((p) => ({
      id: p.id,
      texto: p.texto,
      tipo: p.tipo,
      puntos: Number(p.puntos) || 0,
      opciones_json: p.opciones_json,
      respuesta_correcta: p.respuesta_correcta
    })),
    respuestas: datos.respuestas,
    puntajes: notas,
    devoluciones: datos.devoluciones,
    devolucion_general: datos.entrega.devoluciones || '',
    puntajesChoice: choicePorId
  });
});

/** Correccion: puntaje del desarrollo por pregunta + devolucion por respuesta.
 *  Si el PDF ya fue enviado, se regenera y se reenvia con las correcciones. */
app.post('/admin/corregir/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const entrega = await stmts.getRespuestaById.get(id);
  if (!entrega) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });

  const preguntas = await stmts.preguntasDeMateria.all(entrega.materia_id || 0);
  const porId = new Map(preguntas.map((p) => [p.id, p]));

  const notas = {};
  for (const [pid, valor] of Object.entries(req.body.puntajes || {})) {
    const pregunta = porId.get(Number(pid));
    if (!pregunta) continue;
    const v = String(valor).trim();
    if (v === '') continue; // sin correccion: no aporta puntos
    if (pregunta.tipo !== 'desarrollo') {
      return res.status(400).json({ ok: false, error: 'El puntaje manual es solo para desarrollo.' });
    }
    const n = puntaje(v);
    const max = Number(pregunta.puntos) || 0;
    if (!Number.isFinite(n) || n < 0 || n > max) {
      return res.status(400).json({
        ok: false,
        error: `Puntaje invalido en la pregunta ${pid}: debe estar entre 0 y ${max}.`
      });
    }
    notas[Number(pid)] = n;
  }

  const devs = {};
  for (const [pid, texto] of Object.entries(req.body.devoluciones || {})) {
    const pregunta = porId.get(Number(pid));
    if (!pregunta || pregunta.tipo !== 'desarrollo') continue; // devolucion solo en desarrollo
    const t = String(texto).trim();
    if (!t) continue;
    if (t.length > 5000) {
      return res.status(400).json({ ok: false, error: 'Devolucion demasiado larga (max 5000).' });
    }
    devs[Number(pid)] = t;
  }

  const general = String(req.body.devolucion_general || '').trim();
  if (general.length > 5000) {
    return res.status(400).json({ ok: false, error: 'Devolucion general demasiado larga (max 5000).' });
  }

  const desarrollo = puntaje(
    Object.values(notas).reduce((a, n) => a + (Number(n) || 0), 0)
  );
  await stmts.guardarCorreccion.run(
    desarrollo,
    desarrollo,
    general || null,
    Object.keys(devs).length ? JSON.stringify(devs) : null,
    Object.keys(notas).length ? JSON.stringify(notas) : null,
    tsServidor(),
    id
  );

  // "Finalizar" cierra la correccion y la marca como hecha en el panel.
  const finalizar = ['1', 'true', true, 1].includes(req.body.finalizar);
  if (finalizar) await stmts.marcarCorregido.run(id);

  const actualizada = await stmts.getRespuestaById.get(id);
  let resultado = null;
  if (Number(actualizada.pdf_enviado) === 1) {
    const datos = await prepararDatosPdf(id);
    if (datos) resultado = await generarYEnviar({ ...datos, entrega: actualizada });
  }

  res.json({
    ok: true,
    puntaje_desarrollo: actualizada.puntaje_desarrollo,
    puntaje_total_obtenido: actualizada.puntaje_total_obtenido,
    pdf_enviado: Number(actualizada.pdf_enviado) || 0,
    corregido: Number(actualizada.corregido) || 0,
    correo: resultado ? resultado.correo : null
  });
});

/** Envia el examen corregido al e-mail del alumno y lo marca como enviado. */
app.post('/admin/enviar/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const entrega = await stmts.getRespuestaById.get(id);
  if (!entrega) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });

  const datos = await prepararDatosPdf(id);
  if (!datos) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });

  const resultado = await generarYEnviar({ ...datos, entrega });
  const pdfEnviado = !!(resultado.correo && resultado.correo.ok);
  if (pdfEnviado) await stmts.marcarPdfEnviado.run(id);

  res.json({
    ok: true,
    pdf: !!resultado.pdf,
    correo: resultado.correo,
    pdf_enviado: pdfEnviado ? 1 : Number(entrega.pdf_enviado) || 0,
    error: resultado.error || null
  });
});

app.get('/admin/pdf/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const datos = await prepararDatosPdf(id);
  if (!datos) return res.status(404).send('Entrega inexistente.');

  try {
    const { filePath } = await generarPdf(datos);
    const nombre = `examen_${datos.alumno.documento}.pdf`;
    // ?ver=1 -> se muestra en la pestana en vez de descargarlo
    if (req.query.ver === '1') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
      return res.sendFile(filePath);
    }
    res.download(filePath, nombre);
  } catch (e) {
    console.error('[admin/pdf]', e);
    res.status(500).send('Error al generar el PDF.');
  }
});

/** Planilla de notas de una materia: encabezado institucional + tabla alfabetica. */
app.get('/admin/planilla/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const materia = await stmts.getMateria.get(id);
  if (!materia) return res.status(404).send('Materia inexistente.');

  const filas = await stmts.alumnosDeMateriaConNota.all(id);
  const alumnos = filas
    .map((a) => {
      const partes = String(a.nombre || '').trim().split(/\s+/);
      return {
        documento: a.documento,
        apellido: partes.length > 1 ? partes[partes.length - 1] : '',
        nombre: partes.slice(0, -1).join(' '),
        nota: a.puntaje_total_obtenido == null ? null : Number(a.puntaje_total_obtenido)
      };
    })
    .sort((x, y) =>
      `${x.apellido} ${x.nombre}`.localeCompare(`${y.apellido} ${y.nombre}`, 'es', {
        sensitivity: 'base'
      })
    );

  try {
    const { filePath } = await generarPlanillaPdf({
      institucion: materia.institucion_nombre || '—',
      materia: materia.nombre,
      fecha: fechaCorta(tsServidor()).split(' - ')[0],
      profesor: materia.profesor || (await getProfesor()).completo || '—',
      alumnos
    });
    const nombreArchivo = `planilla_${materia.nombre}`.replace(/[^\w.-]+/g, '_') + '.pdf';
    res.download(filePath, nombreArchivo);
  } catch (e) {
    console.error('[planilla]', e);
    res.status(500).send('Error al generar la planilla.');
  }
});

app.get('/admin/preview/:id', requiereAdmin, async (req, res) => {
  const datos = await prepararDatosPdf(Number(req.params.id));
  if (!datos) return res.status(404).send('Entrega inexistente.');
  const { construirHtml } = require('./lib/pdf');
  res.type('html').send(construirHtml(datos));
});

/* --------- CRUD de preguntas --------- */

app.get('/admin/preguntas', requiereAdmin, async (req, res) => {
  const materiaSel = Number(req.query.materia) || 0;
  const todas = await stmts.listarPreguntas.all();
  const visibles = materiaSel ? todas.filter((p) => p.materia_id === materiaSel) : todas;
  const totalPuntos = puntaje(visibles.reduce((a, p) => a + (Number(p.puntos) || 0), 0));
  res.render('admin/preguntas', {
    preguntas: visibles,
    totalPuntos,
    materias: await stmts.listarMaterias.all(),
    materiaSel,
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

function leerPreguntaForm(body) {
  const texto = String(body.texto || '').trim();
  const tipo = body.tipo === 'choice' ? 'choice' : 'desarrollo';
  const puntos = puntaje(body.puntos);
  const materia_id = Number(body.materia_id) || null;
  if (!materia_id) throw new Error('Elegi la materia de la pregunta.');

  let opciones_json = null;
  let respuesta_correcta = null;

  if (tipo === 'choice') {
    const lineas = String(body.opciones || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (lineas.length < 2) throw new Error('Una pregunta choice necesita al menos 2 opciones.');

    const correctas = String(body.correctas || '')
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((n) => parseInt(n, 10) - 1) // el usuario escribe 1-based
      .filter((n) => Number.isInteger(n) && n >= 0 && n < lineas.length);

    if (correctas.length === 0) throw new Error('Marca al menos una respuesta correcta (1..N).');

    opciones_json = JSON.stringify(lineas);
    respuesta_correcta = JSON.stringify([...new Set(correctas)].sort((a, b) => a - b));
  }

  const obligatoria = body.obligatoria === '1' || body.obligatoria === 'on' ? 1 : 0;

  return { texto, tipo, opciones_json, respuesta_correcta, puntos, obligatoria, materia_id };
}

function destinoPreguntas(body) {
  const m = Number(body.materia_sel) || 0;
  return m ? `/admin/preguntas?materia=${m}&` : '/admin/preguntas?';
}

app.post('/admin/preguntas', requiereAdmin, async (req, res) => {
  try {
    const p = leerPreguntaForm(req.body);
    if (!p.texto) throw new Error('El texto de la pregunta es obligatorio.');
    await stmts.crearPregunta.run(
      p.texto, p.tipo, p.opciones_json, p.respuesta_correcta, p.puntos, p.obligatoria, p.materia_id
    );
    res.redirect(destinoPreguntas(req.body) + 'ok=Pregunta+creada');
  } catch (e) {
    res.redirect(destinoPreguntas(req.body) + `error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/preguntas/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmts.getPregunta.get(id))) throw new Error('Pregunta inexistente.');
    const p = leerPreguntaForm(req.body);
    if (!p.texto) throw new Error('El texto de la pregunta es obligatorio.');
    await stmts.editarPregunta.run(
      p.texto, p.tipo, p.opciones_json, p.respuesta_correcta, p.puntos, p.obligatoria,
      p.materia_id, id
    );
    res.redirect(destinoPreguntas(req.body) + 'ok=Pregunta+actualizada');
  } catch (e) {
    res.redirect(destinoPreguntas(req.body) + `error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/preguntas/:id/borrar', requiereAdmin, async (req, res) => {
  await stmts.borrarPregunta.run(Number(req.params.id));
  res.redirect(destinoPreguntas(req.body) + 'ok=Pregunta+borrada');
});

/* --------- CRUD de instituciones y materias --------- */

app.get('/admin/instituciones', requiereAdmin, async (req, res) => {
  res.render('admin/instituciones', {
    instituciones: await stmts.listarInstituciones.all(),
    materias: await stmts.listarMaterias.all(),
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

app.post('/admin/instituciones', requiereAdmin, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) throw new Error('El nombre es obligatorio.');
    await stmts.crearInstitucion.run(nombre);
    res.redirect('/admin/instituciones?ok=Institucion+creada');
  } catch (e) {
    res.redirect(`/admin/instituciones?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/instituciones/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    if (!nombre) throw new Error('El nombre es obligatorio.');
    const pdf_titulo = String(req.body.pdf_titulo || '').trim();
    const pdf_encabezado = String(req.body.pdf_encabezado || '').trim();
    if (pdf_titulo.length > 200) throw new Error('Titulo del PDF demasiado largo (max 200).');
    if (pdf_encabezado.length > 2000) {
      throw new Error('Encabezado del PDF demasiado largo (max 2000).');
    }
    await stmts.editarInstitucion.run(
      nombre,
      pdf_titulo || null,
      pdf_encabezado || null,
      Number(req.params.id)
    );
    res.redirect('/admin/instituciones?ok=Institucion+actualizada');
  } catch (e) {
    res.redirect(`/admin/instituciones?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/instituciones/:id/borrar', requiereAdmin, async (req, res) => {
  await borrarInstitucionEnCascada(Number(req.params.id));
  res.redirect('/admin/instituciones?ok=Institucion+borrada');
});

/** '01:30' / '1h30' / '90' -> minutos. Vacio = 60 por defecto. */
function minutosDeDuracion(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return 60;
  const hm = /^(\d{1,2})[:h](\d{1,2})$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** datetime-local ('2026-11-20T10:00') -> 'YYYY-MM-DD HH:MM'. undefined = invalido. */
function normalizarFechaHora(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function leerMateriaForm(body) {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) throw new Error('El nombre es obligatorio.');

  const duracion = minutosDeDuracion(body.duracion);
  if (duracion == null || duracion < 1 || duracion > 24 * 60) {
    throw new Error('Duracion invalida: usa HH:MM (maximo 24:00).');
  }

  const profesor = String(body.profesor || '').trim();
  if (profesor.length > 100) throw new Error('Profesor demasiado largo (max 100).');

  const desde = normalizarFechaHora(body.disponible_desde);
  const hasta = normalizarFechaHora(body.disponible_hasta);
  if (desde === undefined || hasta === undefined) throw new Error('Fecha y hora invalidas.');
  if ((desde && !hasta) || (!desde && hasta)) {
    throw new Error('Completa el inicio y el fin de la ventana del examen.');
  }
  if (desde && hasta && hasta <= desde) {
    throw new Error('El fin de la ventana debe ser posterior al inicio.');
  }

  return {
    nombre,
    duracion_minutos: duracion,
    disponible_desde: desde,
    disponible_hasta: hasta,
    profesor: profesor || null
  };
}

app.post('/admin/materias', requiereAdmin, async (req, res) => {
  try {
    const m = leerMateriaForm(req.body);
    const institucion_id = Number(req.body.institucion_id) || 0;
    if (!(await stmts.getInstitucion.get(institucion_id))) throw new Error('Elegi una institucion.');
    await stmts.crearMateria.run(
      m.nombre,
      institucion_id,
      m.duracion_minutos,
      m.disponible_desde,
      m.disponible_hasta,
      m.profesor
    );
    res.redirect('/admin/instituciones?ok=Materia+creada');
  } catch (e) {
    res.redirect(`/admin/instituciones?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/materias/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const m = leerMateriaForm(req.body);
    await stmts.editarMateria.run(
      m.nombre,
      m.duracion_minutos,
      m.disponible_desde,
      m.disponible_hasta,
      m.profesor,
      Number(req.params.id)
    );
    res.redirect('/admin/instituciones?ok=Materia+actualizada');
  } catch (e) {
    res.redirect(`/admin/instituciones?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/materias/:id/borrar', requiereAdmin, async (req, res) => {
  await borrarMateriaEnCascada(Number(req.params.id));
  res.redirect('/admin/instituciones?ok=Materia+borrada');
});

/* --------- CRUD de grupos --------- */

const DIAS_SEMANA = [
  { n: 0, label: 'Domingo' },
  { n: 1, label: 'Lunes' },
  { n: 2, label: 'Martes' },
  { n: 3, label: 'Miercoles' },
  { n: 4, label: 'Jueves' },
  { n: 5, label: 'Viernes' },
  { n: 6, label: 'Sabado' }
];

app.get('/admin/grupos', requiereAdmin, async (req, res) => {
  res.render('admin/grupos', {
    grupos: await stmts.listarGrupos.all(),
    dias: DIAS_SEMANA,
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

function leerGrupoForm(body) {
  const nombre = String(body.nombre || '').trim();
  const dia = Number(body.dia);
  const hora_desde = String(body.hora_desde || '').trim();
  const hora_hasta = String(body.hora_hasta || '').trim();
  const horaRe = /^([01]\d|2[0-3]):[0-5]\d$/;

  if (!nombre) throw new Error('El nombre es obligatorio.');
  if (nombre.length > 60) throw new Error('Nombre demasiado largo (max 60).');
  if (!DIAS_SEMANA.some((d) => d.n === dia)) throw new Error('Dia invalido.');
  if (!horaRe.test(hora_desde)) throw new Error('Hora de inicio invalida (HH:MM).');
  if (!horaRe.test(hora_hasta)) throw new Error('Hora de fin invalida (HH:MM).');
  if (hora_desde >= hora_hasta) throw new Error('La hora de fin debe ser posterior a la de inicio.');

  return { nombre, dia, hora_desde, hora_hasta };
}

app.post('/admin/grupos', requiereAdmin, async (req, res) => {
  try {
    const g = leerGrupoForm(req.body);
    await stmts.crearGrupo.run(g.nombre, g.dia, g.hora_desde, g.hora_hasta);
    res.redirect('/admin/grupos?ok=Grupo+creado');
  } catch (e) {
    res.redirect(`/admin/grupos?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/grupos/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmts.getGrupo.get(id))) throw new Error('Grupo inexistente.');
    const g = leerGrupoForm(req.body);
    await stmts.editarGrupo.run(g.nombre, g.dia, g.hora_desde, g.hora_hasta, id);
    res.redirect('/admin/grupos?ok=Grupo+actualizado');
  } catch (e) {
    res.redirect(`/admin/grupos?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/grupos/:id/borrar', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const alumnos = (await stmts.contarAlumnosDeGrupo.get(id)).n;
  if (alumnos > 0) {
    return res.redirect(
      '/admin/grupos?error=' +
        encodeURIComponent(`No se puede borrar: el grupo tiene ${alumnos} alumno(s).`)
    );
  }
  await stmts.borrarGrupo.run(id);
  res.redirect('/admin/grupos?ok=Grupo+borrado');
});

/* --------- CRUD de alumnos --------- */

app.get('/admin/alumnos', requiereAdmin, async (req, res) => {
  res.render('admin/alumnos', {
    alumnos: await stmts.listarAlumnos.all(),
    materias: await stmts.listarMaterias.all(),
    instituciones: await stmts.listarInstituciones.all(),
    grupos: await stmts.listarGrupos.all(),
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

async function leerAlumnoForm(body) {
  const documento = String(body.documento || '').trim();
  const nombre = String(body.nombre || '').trim();
  const email = String(body.email || '').trim();
  const grupo_id = Number(body.grupo_id) || 0;
  const materia_id = Number(body.materia_id) || 0;

  if (!documento) throw new Error('El documento es obligatorio.');
  if (!/^[0-9A-Za-z.\-]{4,20}$/.test(documento)) {
    throw new Error('Documento invalido (4 a 20 caracteres: numeros o letras).');
  }
  if (!nombre) throw new Error('El nombre es obligatorio.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email invalido.');
  }
  if (!(await stmts.getMateria.get(materia_id))) throw new Error('Elegi una materia.');
  if (!(await stmts.getGrupo.get(grupo_id))) throw new Error('Elegi un grupo.');

  return { documento, nombre, email, grupo_id, materia_id };
}

app.post('/admin/alumnos', requiereAdmin, async (req, res) => {
  try {
    const a = await leerAlumnoForm(req.body);
    await stmts.crearAlumno.run(a.documento, a.nombre, a.email, a.grupo_id, a.materia_id);
    res.redirect('/admin/alumnos?ok=Alumno+creado');
  } catch (e) {
    res.redirect(`/admin/alumnos?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/alumnos/:documento/editar', requiereAdmin, async (req, res) => {
  try {
    const doc = String(req.params.documento);
    if (!(await stmts.getAlumno.get(doc))) throw new Error('Alumno inexistente.');
    const a = await leerAlumnoForm(req.body);
    await stmts.editarAlumno.run(a.nombre, a.email, a.grupo_id, a.materia_id, doc);
    res.redirect('/admin/alumnos?ok=Alumno+actualizado');
  } catch (e) {
    res.redirect(`/admin/alumnos?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/admin/alumnos/:documento/borrar', requiereAdmin, async (req, res) => {
  // La entrega (si existe) se conserva como historial.
  await stmts.borrarAlumno.run(String(req.params.documento));
  res.redirect('/admin/alumnos?ok=Alumno+borrado');
});

/* ------------------------------------------------------------------ */
/*  CRUD DE EXAMENES                                                  */
/* ------------------------------------------------------------------ */

/** 'YYYY-MM-DDTHH:MM' (input datetime-local) -> 'YYYY-MM-DD HH:MM'. */
function normalizarFechaHoraExamen(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function leerExamenForm(body) {
  const nombre = String(body.nombre || '').trim();
  if (!nombre) throw new Error('El nombre del examen es obligatorio.');
  if (nombre.length > 120) throw new Error('Nombre demasiado largo (max 120).');

  const materia_id = Number(body.materia_id) || 0;
  if (!(stmts.getMateria.get(materia_id))) throw new Error('Elegi una materia.');

  const duracion = Number(body.duracion_minutos);
  if (!Number.isFinite(duracion) || duracion < 1 || duracion > 24 * 60) {
    throw new Error('Duracion invalida (1 a 1440 minutos).');
  }

  const desde = normalizarFechaHoraExamen(body.disponible_desde);
  const hasta = normalizarFechaHoraExamen(body.disponible_hasta);
  if (desde === undefined || hasta === undefined) {
    throw new Error('Fecha y hora invalidas.');
  }
  if (desde && hasta && hasta <= desde) {
    throw new Error('El fin de la ventana debe ser posterior al inicio.');
  }

  return { nombre, materia_id, duracion_minutos: duracion, disponible_desde: desde || null, disponible_hasta: hasta || null };
}

/** Lista de examenes (no archivados) con datos de materia e institucion. */
app.get('/admin/examenes', requiereAdmin, async (req, res) => {
  const materiaSel = Number(req.query.materia) || 0;
  let examenes = await stmtsExamenes.listarExamenes.all();
  examenes = examenes.filter((e) => e.archivado === 0);
  if (materiaSel) examenes = examenes.filter((e) => e.materia_id === materiaSel);
  const materias = await stmts.listarMaterias.all();
  res.render('admin/examenes', {
    examenes,
    materias,
    materiaSel,
    archivados: false,
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

/** Lista de examenes archivados. */
app.get('/admin/examenes/archivados', requiereAdmin, async (req, res) => {
  const examenes = await stmtsExamenes.listarExamenesArchivados.all();
  const materias = await stmts.listarMaterias.all();
  res.render('admin/examenes-archivados', {
    examenes,
    materias,
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

/** Crear examen. */
app.post('/admin/examenes', requiereAdmin, async (req, res) => {
  try {
    const e = leerExamenForm(req.body);
    await stmtsExamenes.crearExamen.run(
      e.materia_id, e.nombre, e.duracion_minutos,
      e.disponible_desde, e.disponible_hasta
    );
    res.redirect('/admin/examenes?ok=Examen+creado');
  } catch (err) {
    res.redirect(`/admin/examenes?error=${encodeURIComponent(err.message)}`);
  }
});

/** Editar examen. */
app.post('/admin/examenes/:id/editar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    const e = leerExamenForm(req.body);
    await stmtsExamenes.editarExamen.run(
      e.nombre, e.duracion_minutos, e.disponible_desde, e.disponible_hasta, id
    );
    res.redirect('/admin/examenes?ok=Examen+actualizado');
  } catch (err) {
    res.redirect(`/admin/examenes?error=${encodeURIComponent(err.message)}`);
  }
});

/** Publicar examen (despublica otros de la misma materia). */
app.post('/admin/examenes/:id/publicar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const examen = await stmtsExamenes.getExamen.get(id);
    if (!examen) throw new Error('Examen inexistente.');
    await stmtsExamenes.despublicarOtrosDeMateria.run(examen.materia_id);
    await stmtsExamenes.publicarExamen.run(1, id);
    res.redirect('/admin/examenes?ok=Examen+publicado');
  } catch (err) {
    res.redirect(`/admin/examenes?error=${encodeURIComponent(err.message)}`);
  }
});

/** Despublicar examen. */
app.post('/admin/examenes/:id/despublicar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    await stmtsExamenes.despublicarExamen.run(id);
    res.redirect('/admin/examenes?ok=Examen+despublicado');
  } catch (err) {
    res.redirect(`/admin/examenes?error=${encodeURIComponent(err.message)}`);
  }
});

/** Archivar examen (pasa a Archivados, no se borra). */
app.post('/admin/examenes/:id/archivar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    await stmtsExamenes.archivarExamen.run(id);
    res.redirect('/admin/examenes?ok=Examen+archivado');
  } catch (err) {
    res.redirect(`/admin/examenes?error=${encodeURIComponent(err.message)}`);
  }
});

/** Restaurar examen desde Archivados. */
app.post('/admin/examenes/:id/restaurar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    await stmtsExamenes.restaurarExamen.run(id);
    res.redirect('/admin/examenes/archivados?ok=Examen+restaurado');
  } catch (err) {
    res.redirect(`/admin/examenes/archivados?error=${encodeURIComponent(err.message)}`);
  }
});


/** Ver detalle de un examen: alumnos asignados y disponibles para asignar. */
app.get('/admin/examenes/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const examen = await stmtsExamenes.getExamen.get(id);
  if (!examen) return res.status(404).send('Examen inexistente.');
  const asignados = await stmtsExamenes.alumnosAsignadosAlExamen.all(id);
  const disponibles = await stmtsExamenes.alumnosParaAsignar.all(examen.materia_id);
  const asignadosDocs = new Set(asignados.map((a) => a.documento));
  const preguntas = await stmtsExamenes.preguntasDeExamen.all(id);
  res.render('admin/examen-detalle', {
    examen,
    asignados,
    disponibles: disponibles.filter((a) => !asignadosDocs.has(a.documento)),
    preguntas,
    ok: req.query.ok || null,
    error: req.query.error || null
  });
});

/** Asignar un alumno al examen. */
app.post('/admin/examenes/:id/asignar-alumno', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const documento = String(req.body.documento_alumno || '').trim();
    if (!documento) throw new Error('Documento requerido.');
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    const alumno = await stmts.getAlumno.get(documento);
    if (!alumno) throw new Error('Alumno inexistente.');
    await stmtsExamenes.asignarAlumno.run(id, documento);
    res.redirect(`/admin/examenes/${id}?ok=Alumno+asignado`);
  } catch (err) {
    res.redirect(`/admin/examenes/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

/** Desasignar un alumno del examen. */
app.post('/admin/examenes/:id/desasignar-alumno', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const documento = String(req.body.documento_alumno || '').trim();
    await stmtsExamenes.desasignarAlumno.run(id, documento);
    res.redirect(`/admin/examenes/${id}?ok=Alumno+desasignado`);
  } catch (err) {
    res.redirect(`/admin/examenes/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

/** Crear pregunta dentro de un examen. */
app.post('/admin/examenes/:id/preguntas', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    const texto = String(req.body.texto || '').trim();
    const tipo = req.body.tipo === 'choice' ? 'choice' : 'desarrollo';
    const puntos = puntaje(req.body.puntos);
    const materia_id = Number(req.body.materia_id) || 0;
    const obligatoria = req.body.obligatoria === '1' || req.body.obligatoria === 'on' ? 1 : 0;
    if (!texto) throw new Error('El texto de la pregunta es obligatorio.');
    if (!materia_id) throw new Error('Materia invalida.');
    let opciones_json = null;
    let respuesta_correcta = null;
    if (tipo === 'choice') {
      const lineas = String(req.body.opciones || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (lineas.length < 2) throw new Error('Una pregunta choice necesita al menos 2 opciones.');
      const correctas = String(req.body.correctas || '').split(/[\s,;]+/).filter(Boolean)
        .map((n) => parseInt(n, 10) - 1).filter((n) => Number.isInteger(n) && n >= 0 && n < lineas.length);
      if (correctas.length === 0) throw new Error('Marca al menos una respuesta correcta.');
      opciones_json = JSON.stringify(lineas);
      respuesta_correcta = JSON.stringify([...new Set(correctas)].sort((a, b) => a - b));
    }
    await stmtsExamenes.crearPreguntaExamen.run(
      texto, tipo, opciones_json, respuesta_correcta, puntos, obligatoria, materia_id, id
    );
    res.redirect(`/admin/examenes/${id}?ok=Pregunta+creada`);
  } catch (err) {
    res.redirect(`/admin/examenes/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

/** Editar pregunta de un examen. */
app.post('/admin/examenes/:id/preguntas/:pid/editar', requiereAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    if (!(await stmtsExamenes.getExamen.get(id))) throw new Error('Examen inexistente.');
    const texto = String(req.body.texto || '').trim();
    const tipo = req.body.tipo === 'choice' ? 'choice' : 'desarrollo';
    const puntos = puntaje(req.body.puntos);
    const materia_id = Number(req.body.materia_id) || 0;
    const obligatoria = req.body.obligatoria === '1' || req.body.obligatoria === 'on' ? 1 : 0;
    if (!texto) throw new Error('El texto de la pregunta es obligatorio.');
    if (!materia_id) throw new Error('Materia invalida.');
    let opciones_json = null;
    let respuesta_correcta = null;
    if (tipo === 'choice') {
      const lineas = String(req.body.opciones || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (lineas.length < 2) throw new Error('Una pregunta choice necesita al menos 2 opciones.');
      const correctas = String(req.body.correctas || '').split(/[\s,;]+/).filter(Boolean)
        .map((n) => parseInt(n, 10) - 1).filter((n) => Number.isInteger(n) && n >= 0 && n < lineas.length);
      if (correctas.length === 0) throw new Error('Marca al menos una respuesta correcta.');
      opciones_json = JSON.stringify(lineas);
      respuesta_correcta = JSON.stringify([...new Set(correctas)].sort((a, b) => a - b));
    }
    await stmtsExamenes.editarPreguntaExamen.run(
      texto, tipo, opciones_json, respuesta_correcta, puntos, obligatoria, materia_id, id, pid
    );
    res.redirect(`/admin/examenes/${id}?ok=Pregunta+actualizada`);
  } catch (err) {
    res.redirect(`/admin/examenes/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

/** Borrar pregunta de un examen. */
app.post('/admin/examenes/:id/preguntas/:pid/borrar', requiereAdmin, async (req, res) => {
  try {
    const pid = Number(req.params.pid);
    const id = Number(req.params.id);
    await stmts.borrarPregunta.run(pid);
    res.redirect(`/admin/examenes/${id}?ok=Pregunta+borrada`);
  } catch (err) {
    res.redirect(`/admin/examenes/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

app.use((req, res) => {
  res.status(404).send('No encontrado.');
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Error interno del servidor.');
});

// En Vercel el runtime importa este modulo y usa el export como handler:
// solo se escucha en un puerto cuando se corre directamente (node server.js).
const ejecucionDirecta = require.main === module;

const server = ejecucionDirecta
  ? app.listen(PORT, () => {
      console.log(`[server] http://localhost:${PORT}`);
      console.log(`[server] Panel admin: /admin`);
      if (process.env.DEV_BYPASS_SCHEDULE === '1') {
        console.log('[server] DEV_BYPASS_SCHEDULE activo: horarios ignorados.');
      }
    })
  : null;

process.on('SIGINT', async () => {
  try {
    const { cerrarBrowser } = require('./lib/pdf');
    await cerrarBrowser();
  } catch { /* noop */ }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
});

// Vercel usa el export por defecto como handler HTTP.
module.exports = app;
