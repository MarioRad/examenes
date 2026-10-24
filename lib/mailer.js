'use strict';

const fs = require('fs');
const nodemailer = require('nodemailer');

function crearTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

/**
 * Envia el PDF adjunto al correo registrado del alumno.
 * Nunca lanza: devuelve {ok:boolean, error?} para que la entrega no falle.
 */
async function enviarPdf({ email, nombre, documento, pdfPath, asuntoExtra }) {
  try {
    const transport = crearTransport();
    if (!transport) {
      return { ok: false, error: 'GMAIL_USER / GMAIL_PASS no configurados en .env' };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: `PDF no encontrado: ${pdfPath}` };
    }

    await transport.sendMail({
      from: `"Sistema de Examenes" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: asuntoExtra || `Examen entregado - ${nombre} (${documento})`,
      text: [
        `Hola ${nombre},`,
        '',
        'Recibimos tu examen. Adjunto encontraras el PDF con tus respuestas',
        'y el puntaje total obtenido.',
        '',
        'Documento: ' + documento,
        'Saludos.'
      ].join('\n'),
      attachments: [{ filename: `examen_${documento}.pdf`, path: pdfPath }]
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { enviarPdf };
