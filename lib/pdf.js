'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// En Vercel el filesystem es de solo lectura salvo /tmp.
const EN_VERCEL = !!process.env.VERCEL;
const PDF_DIR = EN_VERCEL ? path.join(os.tmpdir(), 'pdfs') : path.join(__dirname, '..', 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

let browserPromise = null;

/** Chromium de Lambda (serverless) o el de puppeteer en desarrollo. */
async function lanzarNavegador() {
  if (EN_VERCEL) {
    // @sparticuz/chromium y puppeteer-core son ESM: en CommonJS solo se cargan con import().
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteerCore = (await import('puppeteer-core')).default;
    return puppeteerCore.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    });
  }
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = lanzarNavegador();
  }
  return browserPromise;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 'YYYY-MM-DD HH:MM:SS' -> 'dd/mm/aaaa - hh:mm'. */
function fechaCorta(ts) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} - ${m[4]}:${m[5]}` : String(ts || '—');
}

function etiquetaCorrecta(pregunta, indice) {
  let resp = [];
  try {
    const v = JSON.parse(pregunta.respuesta_correcta || '[]');
    resp = Array.isArray(v) ? v : [v];
  } catch { /* noop */ }
  return resp.map(Number).includes(Number(indice));
}

/**
 * Renderiza el HTML del examen (tal cual lo acomodo el alumno, con imagenes
 * Base64) dentro de una hoja con cabecera formal.
 */
function construirHtml({ alumno, entrega, preguntas, respuestas }) {
  const bloqueos = preguntas.map((p) => {
    const raw = respuestas ? respuestas[p.id] : undefined;

    let cuerpo = '';
    let extra = '';

    if (p.tipo === 'choice') {
      let opciones = [];
      try { opciones = JSON.parse(p.opciones_json || '[]'); } catch { /* noop */ }

      let sel = [];
      if (Array.isArray(raw)) sel = raw.map(Number);
      else if (typeof raw === 'string' && raw !== '') {
        try { const v = JSON.parse(raw); sel = Array.isArray(v) ? v.map(Number) : [Number(v)]; }
        catch { sel = [Number(raw)]; }
      } else if (typeof raw === 'number') sel = [raw];

      cuerpo = opciones
        .map((op, i) => {
          const marcado = sel.includes(i);
          const esCorrecta = etiquetaCorrecta(p, i);
          const icono = marcado ? (esCorrecta ? '✔' : '✘') : (esCorrecta ? '(correcta)' : '');
          return `<li class="${marcado ? 'sel' : ''}">${marcado ? '<strong>' : ''}${escapeHtml(op)}${
            marcado ? '</strong>' : ''
          } <span class="marca">${icono}</span></li>`;
        })
        .join('');
      cuerpo = `<ul class="opciones">${cuerpo}</ul>`;
      extra = `<span class="badge">Eleccion</span>`;
    } else {
      cuerpo = raw
        ? `<div class="respuesta-rich">${String(raw)}</div>`
        : `<p class="vacio">(sin respuesta)</p>`;
      extra = `<span class="badge">Desarrollo</span>`;
    }

    return `
      <section class="pregunta">
        <header>
          <h2>${escapeHtml(p.texto)}</h2>
          <div class="meta">
            ${extra}
            <span class="puntos">${p.puntos} pts</span>
          </div>
        </header>
        ${cuerpo}
      </section>`;
  });

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Examen - ${escapeHtml(alumno.nombre)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; padding: 28px; font-size: 13px; }
  .doc-header { border: 2px solid #16324f; border-radius: 6px; padding: 16px 18px; margin-bottom: 22px; background: #f4f7fb; }
  .doc-header h1 { margin: 0 0 10px; font-size: 19px; color: #16324f; letter-spacing: .3px; }
  .enc-libre { margin: -4px 0 12px; font-size: 12.5px; line-height: 1.5; color: #3c4a57; white-space: normal; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 14px; }
  .campo b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: #5a6b7d; }
  .campo span { font-size: 13px; }
  .total { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #9db0c4; font-size: 15px; }
  .total strong { color: #16324f; }
  .pregunta { page-break-inside: avoid; margin-bottom: 16px; padding: 12px 14px; border: 1px solid #d7dee6; border-radius: 5px; }
  .pregunta header { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
  .pregunta h2 { font-size: 13.5px; margin: 0 0 8px; line-height: 1.35; }
  .meta { white-space: nowrap; }
  .badge { display: inline-block; font-size: 10px; background: #16324f; color: #fff; padding: 2px 7px; border-radius: 10px; margin-right: 6px; }
  .puntos { font-size: 11px; color: #5a6b7d; }
  .opciones { margin: 6px 0 0; padding-left: 18px; }
  .opciones li { margin-bottom: 3px; }
  .opciones .sel { color: #0b5c2e; }
  .opciones .marca { font-size: 11px; color: #7a8794; }
  .respuesta-rich { line-height: 1.5; overflow: hidden; }
  .respuesta-rich img { max-width: 100%; height: auto; border-radius: 4px; }
  .respuesta-rich p { margin: 0 0 6px; }
  .vacio { color: #98a4b0; font-style: italic; margin: 4px 0 0; }
  .devoluciones { margin-bottom: 20px; padding: 12px 14px; border: 1px solid #c9a227; border-left: 4px solid #c9a227; border-radius: 5px; background: #fdf8e8; page-break-inside: avoid; }
  .devoluciones h3 { margin: 0 0 8px; font-size: 13px; color: #7a5c00; text-transform: uppercase; letter-spacing: .5px; }
  .dev-texto { line-height: 1.55; white-space: normal; }
</style>
</head>
<body>
  <div class="doc-header">
    <h1>${alumno.institucion_pdf_titulo ? escapeHtml(alumno.institucion_pdf_titulo) : 'Informe de Examen &mdash; Respuestas del alumno'}</h1>
    ${alumno.institucion_pdf_encabezado ? `<p class="enc-libre">${escapeHtml(alumno.institucion_pdf_encabezado).replace(/\n/g, '<br />')}</p>` : ''}
    <div class="grid">
      <div class="campo"><b>Nombre</b><span>${escapeHtml(alumno.nombre)}</span></div>
      <div class="campo"><b>Documento</b><span>${escapeHtml(alumno.documento)}</span></div>
      <div class="campo"><b>Institucion</b><span>${escapeHtml(alumno.institucion_nombre || '-')}</span></div>
      <div class="campo"><b>Materia</b><span>${escapeHtml(alumno.materia_nombre || '-')}</span></div>
      <div class="campo"><b>Fecha y hora (servidor)</b><span>${escapeHtml(fechaCorta(entrega.timestamp_entrega))}</span></div>
      <div class="campo"><b>Abandonos de pestana</b><span>${entrega.abandonos_count} aviso(s)</span></div>
      <div class="campo"><b>Estado</b><span>${escapeHtml(entrega.estado)}</span></div>
      <div class="campo"><b>Grupo</b><span>${escapeHtml(alumno.grupo_nombre || alumno.grupo_dia || '-')}</span></div>
      <div class="campo"><b>Puntaje choice (auto)</b><span>${entrega.puntaje_choice} pts</span></div>
      <div class="campo"><b>Puntaje desarrollo (manual)</b><span>${entrega.puntaje_desarrollo} pts</span></div>
    </div>
    <div class="total"><strong>PUNTAJE TOTAL OBTENIDO: ${entrega.puntaje_total_obtenido} pts</strong></div>
  </div>
  ${
    entrega.devoluciones
      ? `<section class="devoluciones">
    <h3>Devoluciones y correcciones</h3>
    <div class="dev-texto">${escapeHtml(entrega.devoluciones).replace(/\n/g, '<br />')}</div>
  </section>`
      : ''
  }
  ${bloqueos.join('\n')}
</body>
</html>`;

  return html;
}

/**
 * Genera el PDF y devuelve { filePath, html }.
 */
async function generarPdf({ alumno, entrega, preguntas, respuestas }) {
  const html = construirHtml({ alumno, entrega, preguntas, respuestas });
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const stamp = String(entrega.timestamp_entrega).replace(/[^0-9A-Za-z]/g, '');
    const filePath = path.join(PDF_DIR, `${alumno.documento}_${stamp}.pdf`);
    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' }
    });
    return { filePath, html };
  } finally {
    await page.close().catch(() => {});
  }
}

async function cerrarBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

module.exports = { generarPdf, construirHtml, PDF_DIR, cerrarBrowser };
