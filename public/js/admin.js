'use strict';

/* =================================================================
   Admin: tabla tiempo real + filtros + calificacion manual
          + CRUD alumnos / instituciones / materias / preguntas
   ================================================================= */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => [...(c || document).querySelectorAll(s)];

  function toast(msg, tipo) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast ' + (tipo || '');
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.hidden = true), 3500);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  /* ================================================================
     PANEL: tiempo real + filtros institucion/materia + calificar
     ================================================================ */
  const tabla = $('#tablaAlumnos');
  const filtroInst = $('#filtroInstitucion');
  const filtroMat = $('#filtroMateria');

  if (tabla && $('#statEntregados')) {
    function aplicarFiltros() {
      const inst = filtroInst ? filtroInst.value : '';
      const mat = filtroMat ? filtroMat.value : '';

      if (filtroMat) {
        $$('#filtroMateria option').forEach((o) => {
          if (!o.value) return;
          o.hidden = inst ? o.dataset.institucion !== inst : false;
          if (o.hidden && o.selected) filtroMat.value = '';
        });
      }

      let visibles = 0;
      let entregados = 0;
      let expulsados = 0;

      $$('#tablaAlumnos tbody tr').forEach((tr) => {
        const okInst = !inst || tr.dataset.institucion === inst;
        const okMat = !mat || tr.dataset.materia === mat;
        const ver = okInst && okMat;
        tr.hidden = !ver;
        if (ver) {
          visibles++;
          if (tr.dataset.estado === 'entregado') entregados++;
          if (tr.dataset.estado === 'expulsado') expulsados++;
        }
      });

      $('#statTotal').textContent = visibles;
      $('#statEntregados').textContent = entregados;
      $('#statExpulsados').textContent = expulsados;
    }

    if (filtroInst) filtroInst.addEventListener('change', aplicarFiltros);
    if (filtroMat) filtroMat.addEventListener('change', aplicarFiltros);

    const devoluciones = {}; // respuestaId -> texto actual (se llena en render)
    const falloEnvio = new Set(); // ids con el ultimo envio de correo fallido

    function fechaCorta(ts) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts || ''));
      return m ? `${m[3]}/${m[2]}/${m[1]} - ${m[4]}:${m[5]}` : '—';
    }

    function render(data) {
      const filas = data.alumnos || [];
      const tbody = $('tbody', tabla);

      filas.forEach((a) => {
        if (a.respuesta_id) {
          devoluciones[a.respuesta_id] = a.devoluciones || '';
        }
      });

      const nuevas = filas
        .map((a) => {
          const id = a.respuesta_id;
          const lock = Number(a.pdf_enviado) === 1;
          const badgeEstado = !a.estado
            ? '<span class="badge muted" title="No entregado">X</span>'
            : a.estado === 'entregado'
              ? '<span class="badge ok" title="Entregado">✓</span>'
              : '<span class="badge err">expulsado</span>';

          const acciones = id
            ? `<button type="button" class="btn btn-sm btn-primary btn-corregir" data-id="${id}">Corregir</button>
               <button type="button" class="btn btn-sm btn-ghost btn-enviar" data-id="${id}">Enviar</button>
               ${lock ? '<span class="badge ok" title="PDF enviado al alumno">enviado</span>' : ''}`
            : '<span class="muted">sin entrega</span>';

          const corr = id
            ? `<b class="suma-corr">${esc(a.puntaje_desarrollo)}</b> ${
                Number(a.corregido) === 1
                  ? '<span class="badge ok" title="Examen corregido">✓</span>'
                  : '<span class="badge warn" title="Examen sin corregir">alerta</span>'
              }`
            : '—';

          const grupoClase = `grupo-${a.grupo_dia}`;
          return `<tr data-documento="${esc(a.documento)}"
                      data-respuesta="${id || ''}"
                      data-institucion="${esc(a.institucion_id || '')}"
                      data-materia="${esc(a.materia_id || '')}"
                      data-estado="${esc(a.estado || '')}"
                      class="${id ? 'fila-entregada' : ''}">
            <td><code>${esc(a.documento)}</code></td>
            <td>${esc(a.nombre)}</td>
            <td>${esc(a.institucion_nombre || '—')}</td>
            <td>${esc(a.materia_nombre || '—')}</td>
            <td><span class="badge ${grupoClase}">${esc(a.grupo_nombre || '—')}</span></td>
            <td class="c-entrego">${id ? 'Si' : 'No'}</td>
            <td class="c-ts">${esc(fechaCorta(a.timestamp_entrega))}</td>
            <td class="c-estado">${badgeEstado}</td>
            <td class="c-avisos">${id ? a.abandonos_count : '—'}</td>
            <td class="c-choice">${id ? a.puntaje_choice : '—'}</td>
            <td class="c-corr">${corr}</td>
            <td class="c-total"><b>${id ? a.puntaje_total_obtenido : '—'}</b></td>
            <td class="c-acciones">${acciones}</td>
          </tr>`;
        })
        .join('');

      // Solo reescribimos si cambio algo (evita pisar el modal de correccion abierto)
      if (tbody.dataset.hash !== hash(nuevas) && modalCorregir.hidden) {
        tbody.innerHTML = nuevas;
        tbody.dataset.hash = hash(nuevas);
      }
      aplicarFiltros();
    }

    async function refrescar() {
      try {
        const r = await fetch('/admin/api/entregas', { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        render(await r.json());
      } catch { /* transitorio */ }
    }

    setInterval(refrescar, 5000);

    /* ---------- Acciones: Corregir / Enviar ---------- */
    const modalCorregir = $('#modalCorregir');
    const corrLista = $('#corrLista');
    const corrSub = $('#corrSubtitulo');
    const corrGeneral = $('#corrGeneral');
    const corrTotal = $('#corrTotal');
    const btnFinalizarCorr = $('#btnFinalizarCorr');
    const btnCancelarCorr = $('#btnCancelarCorr');

    let corrId = null;
    let corrPreguntas = [];
    let corrChoice = 0;

    async function abrirCorregir(id) {
      corrId = id;
      btnFinalizarCorr.disabled = false;
      btnFinalizarCorr.textContent = 'Finalizar';
      try {
        const r = await fetch(`/admin/api/entrega/${id}`, { headers: { Accept: 'application/json' } });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || 'Error');

        corrSub.textContent = `${d.alumno.documento} — ${d.alumno.nombre} · ${
          d.alumno.materia_nombre || '—'
        }`;
        corrGeneral.value = d.devolucion_general || '';
        corrPreguntas = d.preguntas;
        corrChoice = Number(d.entrega.puntaje_choice) || 0;
        corrLista.innerHTML = d.preguntas.map((p) => bloqueCorreccion(p, d)).join('');
        actualizarTotalCorreccion();
        modalCorregir.hidden = false;
      } catch (err) {
        toast('No se pudo abrir la correccion: ' + err.message, 'err');
        corrId = null;
      }
    }

    function bloqueCorreccion(p, d) {
      const resp = d.respuestas[p.id];
      const devs = d.devoluciones || {};

      let cuerpo;
      if (p.tipo === 'choice') {
        let ops = [];
        let correctas = [];
        try { ops = JSON.parse(p.opciones_json || '[]'); } catch { /* noop */ }
        try { correctas = JSON.parse(p.respuesta_correcta || '[]').map(Number); } catch { /* noop */ }
        const sel = Array.isArray(resp) ? resp.map(Number) : [];
        cuerpo = `<ul class="corr-opciones">${ops
          .map((op, i) => {
            const cls = correctas.includes(i) ? 'ok' : sel.includes(i) ? 'mal' : '';
            const marca = correctas.includes(i) ? '✔' : sel.includes(i) ? '✘' : '•';
            return `<li class="${cls}">${marca} ${esc(op)}</li>`;
          })
          .join('')}</ul>`;
      } else {
        cuerpo = resp ? `<div class="corr-respuesta">${resp}</div>` : '<p class="muted">(sin respuesta)</p>';
      }

      const puntajeHtml =
        p.tipo === 'desarrollo'
          ? `<input type="number" min="0" step="0.01" max="${p.puntos}" class="corr-nota"
               data-pid="${p.id}"
               value="${d.puntajes && d.puntajes[p.id] != null ? esc(d.puntajes[p.id]) : ''}"
               placeholder="0-${p.puntos}" aria-label="Puntaje de la pregunta ${p.id}" />`
          : `<span class="badge ${d.puntajesChoice[p.id] ? 'ok' : 'err'}">${d.puntajesChoice[p.id] || 0} pts</span>`;

      return `
        <section class="corr-item" data-id="${p.id}">
          <header class="corr-item-head">
            <div class="corr-texto"><b>${esc(p.texto)}</b></div>
            <div class="corr-puntaje">${p.tipo === 'choice' ? 'auto' : '0-' + p.puntos} ${puntajeHtml}</div>
          </header>
          ${cuerpo}
          ${
            p.tipo === 'desarrollo'
              ? `<textarea class="corr-devolucion" data-pid="${p.id}" rows="2" maxlength="5000"
            placeholder="Devolucion del profesor (opcional)">${esc(devs[p.id] || '')}</textarea>`
              : ''
          }
        </section>`;
    }

    function actualizarTotalCorreccion() {
      let desarrollo = 0;
      corrLista.querySelectorAll('.corr-nota').forEach((inp) => {
        const v = Number(String(inp.value).replace(',', '.'));
        if (Number.isFinite(v) && v > 0) desarrollo += v;
      });
      const max = corrPreguntas.reduce(
        (a, p) => a + (p.tipo === 'desarrollo' ? Number(p.puntos) || 0 : 0),
        0
      );
      const red = (n) => Math.round(n * 100) / 100;
      corrTotal.textContent = `Total: ${red(corrChoice + desarrollo)} pts (choice ${red(
        corrChoice
      )} + desarrollo ${red(desarrollo)} de ${max})`;
    }

    function cerrarCorreccion() {
      modalCorregir.hidden = true;
      corrId = null;
    }

    btnCancelarCorr.addEventListener('click', cerrarCorreccion);
    modalCorregir.addEventListener('click', (e) => {
      if (e.target === modalCorregir) cerrarCorreccion();
    });
    corrLista.addEventListener('input', actualizarTotalCorreccion);

    tabla.addEventListener('click', async (e) => {
      const btnCorregir = e.target.closest('.btn-corregir');
      if (btnCorregir) return abrirCorregir(btnCorregir.dataset.id);

      const btnEnviar = e.target.closest('.btn-enviar');
      if (btnEnviar) {
        const id = btnEnviar.dataset.id;
        btnEnviar.disabled = true;
        btnEnviar.textContent = '...';
        try {
          const r = await fetch(`/admin/enviar/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: '{}'
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || 'Error');
          const enviado = !!(d.correo && d.correo.ok);
          if (enviado) falloEnvio.delete(id);
          else falloEnvio.add(id);
          toast(
            enviado
              ? 'PDF generado y enviado al e-mail del alumno.'
              : `PDF generado, correo NO enviado${d.correo && d.correo.error ? ': ' + d.correo.error : ''}.`,
            enviado ? 'ok' : 'err'
          );
          await refrescar();
        } catch (err) {
          toast('No se pudo enviar: ' + err.message, 'err');
          btnEnviar.disabled = false;
          btnEnviar.textContent = 'Enviar';
        }
        return;
      }

      // Clic en la fila: abre el examen del alumno con sus respuestas
      const fila = e.target.closest('tr[data-respuesta]');
      if (fila && fila.dataset.respuesta) abrirCorregir(fila.dataset.respuesta);
    });

    btnFinalizarCorr.addEventListener('click', async () => {
      if (!corrId) return;
      btnFinalizarCorr.disabled = true;
      btnFinalizarCorr.textContent = '...';

      const puntajes = {};
      corrLista.querySelectorAll('.corr-nota').forEach((inp) => {
        if (String(inp.value).trim() !== '') puntajes[inp.dataset.pid] = String(inp.value).trim();
      });
      const devsPorPregunta = {};
      corrLista.querySelectorAll('.corr-devolucion').forEach((ta) => {
        if (ta.value.trim() !== '') devsPorPregunta[ta.dataset.pid] = ta.value.trim();
      });

      try {
        const r = await fetch(`/admin/corregir/${idDeCorreccion()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            puntajes,
            devoluciones: devsPorPregunta,
            devolucion_general: corrGeneral.value,
            finalizar: 1
          })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || 'Error');
        const extra =
          Number(d.pdf_enviado) === 1
            ? d.correo && d.correo.ok
              ? ' — PDF reenviado al alumno.'
              : ' — PDF regenerado, correo NO enviado.'
            : ' (el PDF se genera al pulsar Enviar).';
        toast(`Correccion finalizada. Total: ${d.puntaje_total_obtenido} pts` + extra, 'ok');
        cerrarCorreccion();
        await refrescar();
      } catch (err) {
        toast('No se pudo finalizar la correccion: ' + err.message, 'err');
      } finally {
        btnFinalizarCorr.disabled = false;
        btnFinalizarCorr.textContent = 'Finalizar';
      }
    });

    function idDeCorreccion() {
      return corrId;
    }

    aplicarFiltros();
  }

  /* ================================================================
     CUENTA DEL PROFESOR: avatar en el barra superior -> modal
     ================================================================ */
  const btnCuenta = $('#btnCuenta');
  const modalCuenta = $('#modalCuenta');
  if (btnCuenta && modalCuenta) {
    const cerrarCuenta = () => (modalCuenta.hidden = true);
    btnCuenta.addEventListener('click', () => {
      modalCuenta.hidden = false;
      const primero = $('#cuentaNombre', modalCuenta);
      if (primero) primero.focus();
    });
    $('#btnCerrarCuenta').addEventListener('click', cerrarCuenta);
    modalCuenta.addEventListener('click', (e) => {
      if (e.target === modalCuenta) cerrarCuenta();
    });

    // Vuelta del formulario (se guarda y se recarga el panel con ?cuenta=1)
    if (new URLSearchParams(window.location.search).get('cuenta')) {
      modalCuenta.hidden = false;
      window.history.replaceState(null, '', window.location.pathname);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const corr = $('#modalCorregir');
    const cuenta = $('#modalCuenta');
    if (corr && !corr.hidden) $('#btnCancelarCorr').click();
    else if (cuenta && !cuenta.hidden) cuenta.hidden = true;
  });

  /* ================================================================
     ALUMNOS: cascada institucion -> materia + editar + filtros
     ================================================================ */
  const formAlumno = $('#formAlumno');
  if (formAlumno) {
    const materias = window.__MATERIAS__ || [];
    const selInst = $('#institucion_id');
    const selMat = $('#materia_id');
    const btnCancelar = $('#btnCancelar');
    const titulo = $('#tituloForm');

    function cargarMaterias(instId, conservar) {
      const opts = materias.filter((m) => String(m.institucion_id) === String(instId));
      selMat.innerHTML =
        '<option value="">-- elegir materia --</option>' +
        opts
          .map((m) => `<option value="${m.id}" ${String(m.id) === String(conservar) ? 'selected' : ''}>${esc(m.nombre)}</option>`)
          .join('');
      if (!opts.length) selMat.innerHTML = '<option value="">-- sin materias en esa institucion --</option>';
    }

    selInst.addEventListener('change', () => cargarMaterias(selInst.value));

    // Editar: volcamos los datos en el formulario
    $$('.btn-editar').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fila = btn.closest('tr');
        if (!fila) return;
        $('#documento').value = fila.dataset.documento || '';
        $('#documento').readOnly = true;
        const celdas = $$('td', fila);
        $('#nombre').value = celdas[1] ? celdas[1].textContent.trim() : '';
        $('#email').value = celdas[2] ? celdas[2].textContent.trim() : '';
        $('#grupo_id').value = fila.dataset.grupo || '';
        selInst.value = fila.dataset.institucion || '';
        cargarMaterias(selInst.value, fila.dataset.materia);

        formAlumno.action = `/admin/alumnos/${encodeURIComponent(fila.dataset.documento)}/editar`;
        titulo.textContent = 'Editar alumno ' + fila.dataset.documento;
        $('#btnGuardarAlumno').textContent = 'Guardar cambios';
        btnCancelar.hidden = false;
        formAlumno.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('#nombre').focus();
      });
    });

    if (btnCancelar) {
      btnCancelar.addEventListener('click', () => {
        formAlumno.reset();
        formAlumno.action = '/admin/alumnos';
        $('#documento').readOnly = false;
        titulo.textContent = 'Nuevo alumno';
        $('#btnGuardarAlumno').textContent = 'Crear alumno';
        btnCancelar.hidden = true;
        cargarMaterias(selInst.value);
      });
    }

    // Filtros de la tabla de alumnos
    const fInst = $('#filtroInstitucion');
    const fMat = $('#filtroMateria');
    function filtrarTablaAlumnos() {
      const inst = fInst ? fInst.value : '';
      const mat = fMat ? fMat.value : '';
      if (fMat) {
        $$('#filtroMateria option').forEach((o) => {
          if (!o.value) return;
          o.hidden = inst ? o.dataset.institucion !== inst : false;
          if (o.hidden && o.selected) fMat.value = '';
        });
      }
      let n = 0;
      $$('#tablaAlumnos tbody tr[data-documento]').forEach((tr) => {
        const ver = (!inst || tr.dataset.institucion === inst) && (!mat || tr.dataset.materia === mat);
        tr.hidden = !ver;
        if (ver) n++;
      });
      const pill = $('.card-tabla .pill');
      if (pill) pill.textContent = n;
    }
    if (fInst) fInst.addEventListener('change', filtrarTablaAlumnos);
    if (fMat) fMat.addEventListener('change', filtrarTablaAlumnos);

    // Estado inicial: si hay una sola materia precargada, mostrarla
    if (selInst.value) cargarMaterias(selInst.value, selMat.dataset.inicial || '');
  }

  /* ================================================================
     INSTITUCIONES / MATERIAS: editar inline + borrado con confirm
     ================================================================ */
  $$('.btn-editar').forEach((btn) => {
    if (btn.closest('#formAlumno')) return; // manejado por la seccion de alumnos
    // En la pagina de preguntas, el handler especifico se encarga
    if (document.querySelector('#formPregunta') && btn.closest('.item-pregunta')) return;
    btn.addEventListener('click', () => {
      const li = btn.closest('.item-pregunta');
      if (li) {
        const f = $('.form-editar', li);
        if (f) {
          f.hidden = false;
          const inp = $('input[name=nombre]', f);
          if (inp) inp.focus();
        }
        return;
      }
      // fila de tabla de materias: la siguiente hermana es la fila de edicion
      const tr = btn.closest('tr');
      if (tr && tr.nextElementSibling && tr.nextElementSibling.classList.contains('fila-edicion')) {
        tr.nextElementSibling.hidden = false;
        const inp = $('input[name=nombre]', tr.nextElementSibling);
        if (inp) inp.focus();
      }
    });
  });

  $$('.btn-cancelar-edicion').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.closest('.form-editar');
      if (!f) return;
      const filaEd = f.closest('.fila-edicion');
      if (filaEd) filaEd.hidden = true;
      else f.hidden = true;
    });
  });

  $$('.form-borrar').forEach((f) => {
    f.addEventListener('submit', (e) => {
      if (!confirm(f.dataset.confirm || '¿Seguro que queres borrar esto?')) e.preventDefault();
    });
  });

  /* ================================================================
     PREGUNuntas: filtro por materia + choice + editar
     ================================================================ */
  const formPregunta = $('#formPregunta');
  if (formPregunta) {
    const tipoSel = $('#tipo');
    const bloqueChoice = $('#bloqueChoice');
    const btnCancelarP = $('#btnCancelar');
    const titulo = $('#tituloForm');
    const materiaSel = $('#materiaSel');

    function syncTipo() {
      bloqueChoice.hidden = tipoSel.value !== 'choice';
    }
    tipoSel.addEventListener('change', syncTipo);
    syncTipo();

    // Filtro del listado -> navega conservando el server-side
    const fMatP = $('#filtroMateria');
    if (fMatP) {
      fMatP.addEventListener('change', () => {
        const m = fMatP.value;
        window.location.href = m ? `/admin/preguntas?materia=${m}` : '/admin/preguntas';
      });
    }

    // Al elegir materia en el form, recordarla para el redirect
    const selMateria = $('#materia_id');
    if (selMateria && materiaSel) {
      selMateria.addEventListener('change', () => (materiaSel.value = selMateria.value));
    }

    /* ---------- Sumatoria de puntos (previsualizacion) ---------- */
    const puntosInput = $('#puntos');
    const resumenSuma = $('#resumenSuma');
    const totalLista = $('#totalPuntos');

    const redondear = (n) => Math.round(n * 100) / 100;
    const sumaLista = () =>
      $$('.item-pregunta').reduce((a, el) => a + (Number(el.dataset.puntos) || 0), 0);

    function actualizarSuma() {
      const base = sumaLista();
      if (totalLista) totalLista.textContent = redondear(base);
      if (!resumenSuma || !puntosInput) return;

      const m = /\/admin\/preguntas\/(\d+)\/editar$/.exec(formPregunta.action);
      const item = m ? document.querySelector(`.item-pregunta[data-id="${m[1]}"]`) : null;
      const previo = item ? Number(item.dataset.puntos) || 0 : 0;
      const nuevo = Number(String(puntosInput.value).replace(',', '.')) || 0;
      const total = redondear(base - previo + nuevo);
      resumenSuma.textContent = `Sumatoria del examen con esta pregunta: ${total} pts (sin ella: ${redondear(
        base - previo
      )} pts).`;
    }

    if (puntosInput) puntosInput.addEventListener('input', actualizarSuma);
    actualizarSuma();

    if (btnCancelarP) {
      btnCancelarP.addEventListener('click', () => {
        formPregunta.reset();
        formPregunta.action = '/admin/preguntas';
        titulo.textContent = 'Nueva pregunta';
        btnCancelarP.hidden = true;
        syncTipo();
        actualizarSuma();
      });
    }

    // Editar: volcamos al formulario principal
    $$('.btn-editar').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.item-pregunta');
        if (!item || !item.classList.contains('item-pregunta')) return;
        const src = $('.form-editar', item);
        if (!src) return;
        $('#texto').value = $('textarea[name=texto]', src).value;
        $('#tipo').value = $('select[name=tipo]', src).value;
        $('#puntos').value = $('input[name=puntos]', src).value;
        const oblSrc = $('input[name=obligatoria]', src);
        const oblForm = $('input[name=obligatoria]', formPregunta);
        if (oblSrc && oblForm) oblForm.checked = oblSrc.checked;
        $('#opciones').value = $('textarea[name=opciones]', src).value;
        $('#correctas').value = $('input[name=correctas]', src).value;
        if (selMateria) selMateria.value = $('select[name=materia_id]', src).value;
        formPregunta.action = `/admin/preguntas/${item.dataset.id}/editar`;
        titulo.textContent = 'Editar pregunta #' + item.dataset.id;
        btnCancelarP.hidden = false;
        syncTipo();
        actualizarSuma();
        formPregunta.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('#texto').focus();
      });
    });

    // Formularios inline de edicion: mostrar solo el clickeado
    $$('.form-editar').forEach((f) => {
      if (f.closest('.item-pregunta')) f.hidden = true;
    });
  }
})();
