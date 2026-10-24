'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const {
  stmts,
  ready,
  borrarMateriaEnCascada,
  borrarInstitucionEnCascada
} = require('./lib/db');
const { LibsqlStore } = require('./lib/session-store');
const {
  validarHorario,
  ventanaDe,
  ventanaExamen,
  etiquetaVentana,
  duracionExamenMs,
  minutosHastaVentana
} = require('./lib/horarios');
const { evaluarChoice } = require('./lib/grading');
const { generarPdf } = require('./lib/pdf');
const { enviarPdf } = require('./lib/mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
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
  const entrega = await stmts.getRespuestaByAlumno.get(req.session.alumno.documento);
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
  const preguntas = alumno ? await stmts.preguntasDeMateria.all(alumno.materia_id || 0) : [];

  const enRango = req.session.fin - Date.now();
  const restante = Math.max(0, Math.min(duracionExamenMs(alumno), enRango));

  const ventanaFechas = etiquetaVentana(alumno);
  const ventanaGrupo = `del grupo ${await ventanaDe(alumno.grupo_id)}`;
  res.render('examen', {
    alumno,
    preguntas,
    restanteMs: restante,
    serverNow: Date.now(),
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
  const alumno = await stmts.getAlumno.get(documento);

  if (await stmts.getRespuestaByAlumno.get(documento)) {
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

  const preguntas = await stmts.preguntasDeMateria.all(alumno.materia_id || 0);
  const { choice } = evaluarChoice(preguntas, respuestas);

  const timestamp = tsServidor();
  const estado = expulsado ? 'expulsado' : 'entregado';

  const fila = {
    documento_alumno: documento,
    nombre_alumno: alumno.nombre,
    materia_id: alumno.materia_id || null,
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

  const entrega = await stmts.getRespuestaByAlumno.get(documento);

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
async function generarYEnviar({ alumno, entrega, preguntas, respuestas }) {
  const out = { pdf: null, correo: null };
  try {
    const { filePath } = await generarPdf({ alumno, entrega, preguntas, respuestas });
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
  return { alumno, entrega, preguntas, respuestas };
}

/* ------------------------------------------------------------------ */
/*  ADMIN                                                              */
/* ------------------------------------------------------------------ */

app.get('/admin', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/panel');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const pass = String(req.body.password || '');
  if (pass !== ADMIN_PASSWORD) {
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
    instituciones: await stmts.listarInstituciones.all(),
    materias: await stmts.listarMaterias.all()
  });
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

/** Calificacion manual del desarrollo + recalculo + PDF + reenvio.
 *  Si el PDF ya fue enviado (pdf_enviado=1) la nota queda bloqueada. */
app.post('/admin/calificar/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const entrega = await stmts.getRespuestaById.get(id);
  if (!entrega) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });
  if (Number(entrega.pdf_enviado) === 1) {
    return res
      .status(409)
      .json({ ok: false, error: 'El PDF ya fue enviado: la nota no puede modificarse.' });
  }

  const puntos = Number(req.body.puntaje_desarrollo);
  if (!Number.isFinite(puntos) || puntos < 0) {
    return res.status(400).json({ ok: false, error: 'Puntaje invalido.' });
  }

  const puntosRedondeados = puntaje(puntos);
  await stmts.calificarDesarrollo.run(puntosRedondeados, puntosRedondeados, id);
  const actualizada = await stmts.getRespuestaById.get(id);

  const datos = await prepararDatosPdf(id);
  const resultado = datos
    ? await generarYEnviar({
        alumno: datos.alumno,
        entrega: actualizada,
        preguntas: datos.preguntas,
        respuestas: datos.respuestas
      })
    : null;

  // Se bloquea la nota recien cuando el PDF efectivamente llego por correo.
  const pdfEnviado = !!(resultado && resultado.correo && resultado.correo.ok);
  if (pdfEnviado) await stmts.marcarPdfEnviado.run(id);

  res.json({
    ok: true,
    puntaje_desarrollo: actualizada.puntaje_desarrollo,
    puntaje_total_obtenido: actualizada.puntaje_total_obtenido,
    pdf_enviado: pdfEnviado ? 1 : Number(actualizada.pdf_enviado) || 0,
    correo: resultado ? resultado.correo : null
  });
});

/** Devoluciones y correcciones del examen.
 *  Si el PDF ya fue enviado, se regenera y reenvia con las correcciones
 *  (la nota queda intacta). Si aun no se corrigio/envio, solo se guarda el
 *  texto: el PDF se generara al calificar (evita duplicados). */
app.post('/admin/devoluciones/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const entrega = await stmts.getRespuestaById.get(id);
  if (!entrega) return res.status(404).json({ ok: false, error: 'Entrega inexistente.' });

  const texto = String(req.body.devoluciones == null ? '' : req.body.devoluciones).trim();
  if (texto.length > 5000) {
    return res.status(400).json({ ok: false, error: 'Texto demasiado largo (max 5000).' });
  }

  await stmts.guardarDevoluciones.run(texto || null, id);
  const actualizada = await stmts.getRespuestaById.get(id);

  let resultado = null;
  if (Number(actualizada.pdf_enviado) === 1) {
    const datos = await prepararDatosPdf(id);
    if (datos) {
      resultado = await generarYEnviar({
        alumno: datos.alumno,
        entrega: actualizada,
        preguntas: datos.preguntas,
        respuestas: datos.respuestas
      });
    }
  }

  res.json({
    ok: true,
    devoluciones: actualizada.devoluciones,
    pdf_enviado: Number(actualizada.pdf_enviado) || 0,
    correo: resultado ? resultado.correo : null
  });
});

app.get('/admin/pdf/:id', requiereAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const datos = await prepararDatosPdf(id);
  if (!datos) return res.status(404).send('Entrega inexistente.');

  try {
    const { filePath } = await generarPdf(datos);
    res.download(filePath, `examen_${datos.alumno.documento}.pdf`);
  } catch (e) {
    console.error('[admin/pdf]', e);
    res.status(500).send('Error al generar el PDF.');
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

  return { texto, tipo, opciones_json, respuesta_correcta, puntos, materia_id };
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
      p.texto, p.tipo, p.opciones_json, p.respuesta_correcta, p.puntos, p.materia_id
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
      p.texto, p.tipo, p.opciones_json, p.respuesta_correcta, p.puntos, p.materia_id, id
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
    disponible_hasta: hasta
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
      m.disponible_hasta
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
