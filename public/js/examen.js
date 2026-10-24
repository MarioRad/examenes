'use strict';

/* =================================================================
   Examen: Quill + temporizador inmutable + anti-fraude (3 avisos)
   ================================================================= */

(function () {
  const CFG = window.__EXAMEN__ || { restanteMs: 0, serverNow: Date.now(), preguntas: [] };

  const $ = (sel) => document.querySelector(sel);
  const reloj = $('#reloj');
  const chipAvisos = $('#chipAvisos');
  const form = $('#formExamen');

  const modalAviso = $('#modalAviso');
  const modalBloqueo = $('#modalBloqueo');
  const modalListo = $('#modalListo');
  const btnEntendido = $('#btnEntendido');
  const btnEnviar = $('#btnEnviar');
  const bloqueoEstado = $('#bloqueoEstado');
  const chipProgreso = $('#chipProgreso');
  const avisoTiempo = $('#avisoTiempo');
  const avisoTiempoMin = $('#avisoTiempoMin');

  /* -------------------- Estado -------------------- */
  let offsetServidor = CFG.serverNow - Date.now(); // servidor - cliente
  const finTs = CFG.serverNow + CFG.restanteMs; // timestamp absoluto de fin

  let abandonos = 0;
  let enviando = false;
  let bloqueado = false;
  let avisoPendiente = null;
  let avisado10 = false;
  const editores = {}; // preguntaId -> Quill

  /* -------------------- Quill -------------------- */
  function iniciarEditores() {
    if (typeof Quill === 'undefined') {
      console.error('Quill no cargo desde el CDN.');
      return;
    }

    const toolbar = [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ list: 'ordered' }, { list: 'bullet' }],
      ['blockquote', 'code-block'],
      ['link', 'image'],
      ['clean']
    ];

    CFG.preguntas
      .filter((p) => p.tipo === 'desarrollo')
      .forEach((p) => {
        const el = document.getElementById('editor_' + p.id);
        if (!el) return;

        const q = new Quill(el, {
          theme: 'snow',
          modules: { toolbar },
          placeholder: 'Escribe tu respuesta aqui... (podes pegar imagenes)'
        });

        // Imagen elegida desde el picker -> Base64 embebido en el HTML
        const toolbarEl = q.getModule('toolbar');
        toolbarEl.addHandler('image', () => {
          const input = toolbarEl.container.querySelector('input.ql-image[type=file]');
          if (!input) return;
          // Quill ya crea el input; solo forzamos accept de imagenes
          input.setAttribute('accept', 'image/*');
          input.click();
        });

        // Pegar imagen desde el portapapeles -> Base64
        q.clipboard.addMatcher(Node.ELEMENT_NODE, (node, delta) => {
          if (node.tagName === 'IMG' && node.src && node.src.startsWith('data:')) {
            const img = document.createElement('img');
            img.src = node.src;
            const Delta = Quill.import('delta');
            return new Delta().insert({ image: node.src });
          }
          return delta;
        });

        editores[p.id] = q;
      });
  }

  /* -------------------- Progreso de la resolucion -------------------- */
  function actualizarProgreso() {
    if (!chipProgreso) return;
    const total = CFG.preguntas.length;
    const respondidas = Object.keys(recoger()).length;
    chipProgreso.textContent = `Respondidas: ${respondidas}/${total}`;
    chipProgreso.classList.toggle('completo', total > 0 && respondidas === total);
  }

  /** Ids de preguntas obligatorias que quedaron sin responder. */
  function faltanObligatorias() {
    const respondidas = recoger();
    return CFG.preguntas
      .filter((p) => p.obligatoria)
      .filter((p) => {
        const v = respondidas[p.id];
        if (v == null) return true;
        if (Array.isArray(v)) return v.length === 0;
        return String(v).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
      })
      .map((p) => p.id);
  }

  function marcarFaltantes(ids) {
    document.querySelectorAll('.card-pregunta').forEach((sec) => sec.classList.remove('falta'));
    const primera = ids
      .map((id) => document.querySelector(`.card-pregunta[data-id="${id}"]`))
      .filter(Boolean);
    primera.forEach((sec) => sec.classList.add('falta'));
    if (primera[0]) primera[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* -------------------- Temporizador -------------------- */
  function restanteReal() {
    return finTs - (Date.now() + offsetServidor);
  }

  function pintarReloj(ms) {
    const seg = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(seg / 3600);
    const m = Math.floor((seg % 3600) / 60);
    const s = seg % 60;
    const p = (n) => String(n).padStart(2, '0');
    reloj.textContent = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
    reloj.classList.toggle('bajo', ms <= 5 * 60 * 1000 && ms > 60 * 1000);
    reloj.classList.toggle('critico', ms <= 60 * 1000);
  }

  /** Aviso unico al alumno cuando queda poco tiempo. */
  function avisarDiezMinutos(ms) {
    if (!avisoTiempo) return;
    if (ms > 10 * 60 * 1000) return;
    const minutos = Math.max(1, Math.ceil(ms / 60000));
    if (avisoTiempoMin) avisoTiempoMin.textContent = String(minutos);
    avisoTiempo.hidden = false;
    avisado10 = true;
  }

  async function sincronizarServidor() {
    try {
      const r = await fetch('/api/tiempo', { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      // corrige drift del reloj local y detecta expiracion remota
      if (Number.isFinite(d.serverNow)) offsetServidor = d.serverNow - Date.now();
      if (d.expirado && !enviando && !bloqueado) entregar('entregado', 'tiempo');
    } catch {
      /* offline: seguimos con el reloj local */
    }
  }

  let tick = null;
  function iniciarTemporizador() {
    pintarReloj(restanteReal());
    tick = setInterval(() => {
      const ms = restanteReal();
      pintarReloj(ms);
      avisarDiezMinutos(ms);
      if (ms <= 0 && !enviando && !bloqueado) {
        clearInterval(tick);
        entregar('entregado', 'tiempo');
      }
    }, 250);

    setInterval(sincronizarServidor, 30000);
    sincronizarServidor();
  }

  /* -------------------- Recoleccion de respuestas -------------------- */
  function recoger() {
    const respuestas = {};

    // choice -> indices seleccionados
    document
      .querySelectorAll('.card-pregunta[data-tipo="choice"]')
      .forEach((sec) => {
        const id = Number(sec.dataset.id);
        const tildes = [...sec.querySelectorAll('input[type=checkbox]:checked, input[type=radio]:checked')];
        if (tildes.length > 0) {
          respuestas[id] = tildes.map((i) => Number(i.value));
        }
      });

    // desarrollo -> HTML de Quill (con imagenes Base64)
    Object.keys(editores).forEach((pid) => {
      const html = editores[pid].root.innerHTML;
      const vacio = editores[pid].getText().trim() === '' && !/<img/i.test(html);
      if (!vacio) respuestas[Number(pid)] = html;
    });

    return respuestas;
  }

  /* -------------------- Entrega -------------------- */
  async function entregar(estado, motivo) {
    if (enviando) return;
    enviando = true;

    if (btnEnviar) {
      btnEnviar.disabled = true;
      btnEnviar.textContent = 'Enviando...';
    }
    if (tick) clearInterval(tick);
    if (avisoTiempo) avisoTiempo.hidden = true;

    try {
      const r = await fetch('/entregar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          respuestas: recoger(),
          estado: estado === 'expulsado' ? 'expulsado' : 'entregado',
          motivo
        })
      });

      let d = {};
      try { d = await r.json(); } catch { /* noop */ }

      if (r.status === 409) {
        mostrarListo({ titulo: 'Ya entregaste tu exámen', choice: 'No se permite un segundo intento. Consulta con tu profesor.' });
        return;
      }
      if (r.status === 410) {
        mostrarListo({ titulo: 'Tiempo agotado', choice: 'El tiempo del exámen expiró. Consulta con tu profesor.' });
        return;
      }
      if (r.status === 400 && Array.isArray(d.faltantes)) {
        enviando = false;
        if (btnEnviar) {
          btnEnviar.disabled = false;
          btnEnviar.textContent = 'Entregar examen';
        }
        if (!bloqueado) iniciarTemporizador();
        marcarFaltantes(d.faltantes);
        alert(d.error || 'Faltan preguntas obligatorias.');
        return;
      }
      if (!r.ok || !d.ok) {
        throw new Error(d.error || 'No se pudo entregar (' + r.status + ').');
      }

      const datosListo = {
        titulo: 'Se entregó tu exámen',
        choice: `En las opciones múltiple choice obtuviste ${d.puntaje_choice} pts.`,
        desarrollo: true,
        correo: d.correo && d.correo.ok
      };

      if (bloqueado) {
        bloqueoEstado.textContent = 'Entregado como EXPULSADO.';
        setTimeout(() => mostrarListo(datosListo), 700);
      } else {
        mostrarListo(datosListo);
      }
      document.body.classList.add('bloqueado');
      desactivarEditores();
    } catch (e) {
      console.error(e);
      enviando = false;
      if (btnEnviar) {
        btnEnviar.disabled = false;
        btnEnviar.textContent = 'Entregar examen';
      }
      alert('No se pudo entregar: ' + e.message + '\nIntenta nuevamente.');
      if (bloqueado) entregar('expulsado', 'reintento');
    }
  }

  function desactivarEditores() {
    Object.values(editores).forEach((q) => q.disable());
    document.querySelectorAll('.card-pregunta input').forEach((i) => (i.disabled = true));
  }

  function mostrarListo(datos) {
    $('#listoTitulo').textContent = datos.titulo || 'Se entregó tu exámen';
    const pChoice = $('#listoChoice');
    pChoice.textContent = datos.choice || '';
    pChoice.hidden = !datos.choice;

    const pDes = $('#listoDesarrollo');
    pDes.hidden = !datos.desarrollo;

    const pCorreo = $('#listoCorreo');
    if (datos.correo === true) {
      pCorreo.textContent = 'Una copia de tus respuestas se enviaron a tu dirección de e-mail.';
      pCorreo.hidden = false;
    } else {
      pCorreo.hidden = true;
    }

    modalBloqueo.hidden = true;
    modalAviso.hidden = true;
    modalListo.hidden = false;
  }

  /* -------------------- Anti-fraude: 3 avisos -------------------- */
  async function reportarAbandono() {
    if (bloqueado || enviando) return;
    try {
      const r = await fetch('/api/abandono', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}'
      });
      if (r.status === 401) return; // sesion caida: nada que hacer
      const d = await r.json();
      abandonos = d.abandonos || 0;
      pintarAvisos();

      if (d.expulsado) {
        expulsar();
      } else {
        mostrarAviso(abandonos);
      }
    } catch (e) {
      // sin red: al menos contamos localmente
      abandonos += 1;
      pintarAvisos();
      if (abandonos >= 3) expulsar();
      else mostrarAviso(abandonos);
    }
  }

  function pintarAvisos() {
    chipAvisos.textContent = `Avisos: ${abandonos}/3`;
    chipAvisos.classList.toggle('peligro', abandonos >= 2);
  }

  function mostrarAviso(n) {
    if (bloqueado || enviando) return;
    avisoPendiente = n;
    $('#modalNro').textContent = String(n);
    modalAviso.hidden = false;
    document.body.classList.add('bloqueado');
    btnEntendido.focus();
  }

  function cerrarAviso() {
    modalAviso.hidden = true;
    avisoPendiente = null;
    if (!bloqueado) document.body.classList.remove('bloqueado');
  }

  function expulsar() {
    if (bloqueado) return;
    bloqueado = true;
    modalAviso.hidden = true;
    document.body.classList.add('bloqueado');
    modalBloqueo.hidden = false;
    bloqueoEstado.textContent = 'Enviando respuestas...';
    desactivarEditores();
    entregar('expulsado', '3-abandonos');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // registramos apenas se oculta; el aviso se muestra al regresar
      if (!bloqueado && !enviando) reportarAbandono();
    }
  });

  // Salir de la pagina tambien cuenta como abandono
  window.addEventListener('pagehide', () => {
    if (bloqueado || enviando) return;
    navigator.sendBeacon &&
      navigator.sendBeacon('/api/abandono', new Blob(['{}'], { type: 'application/json' }));
  });

  btnEntendido.addEventListener('click', cerrarAviso);

  /* -------------------- UI inicial -------------------- */
  if (btnEnviar) {
    btnEnviar.addEventListener('click', () => {
      if (bloqueado) return;

      const faltantes = faltanObligatorias();
      if (faltantes.length > 0) {
        marcarFaltantes(faltantes);
        alert(
          faltantes.length === 1
            ? 'Tenes 1 pregunta obligatoria sin responder. Completala antes de entregar.'
            : `Tenes ${faltantes.length} preguntas obligatorias sin responder. Completalas antes de entregar.`
        );
        return;
      }

      const total = CFG.preguntas.length;
      const respondidas = Object.keys(recoger()).length;
      const ok = confirm(
        `Vas a entregar el examen.\n\nRespondiste ${respondidas} de ${total} preguntas.\n\n¿Continuar?`
      );
      if (ok) entregar('entregado', 'manual');
    });
  }

  $('#btnCerrarListo').addEventListener('click', () => {
    window.location.href = '/';
  });

  // Teclado: evitar que el navegador reclame el foco perdido como accion del usuario
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalAviso.hidden) cerrarAviso();
  });

  iniciarEditores();

  // Progreso: se recalcula al tildar opciones o escribir en los editores.
  document.addEventListener('change', (e) => {
    if (e.target.closest && e.target.closest('.card-pregunta')) actualizarProgreso();
  });
  Object.values(editores).forEach((q) => q.on('text-change', actualizarProgreso));

  iniciarTemporizador();
  pintarAvisos();
  actualizarProgreso();
})();
