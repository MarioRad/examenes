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
            ? `<a class="btn btn-sm btn-primary" href="/admin/pdf/${id}" title="Descargar PDF">PDF</a>
               <a class="btn btn-sm btn-ghost" href="/admin/preview/${id}" target="_blank" title="Ver respuestas">Ver</a>
               <button type="button" class="btn btn-sm btn-ghost btn-correccion ${a.devoluciones ? 'tiene-dev' : ''}" data-id="${id}">Corrección</button>
               <button type="button" class="btn btn-sm btn-guardar" data-id="${id}"
                 ${falloEnvio.has(id) && !lock ? '' : 'hidden'}>${falloEnvio.has(id) ? 'Reenviar' : 'Guardar'}</button>`
            : '<span class="muted">sin entrega</span>';

          const nota = id
            ? `<input type="number" min="0" step="1" class="input-nota"
                 value="${a.puntaje_desarrollo}" data-id="${id}"
                 ${lock ? 'disabled title="PDF enviado: la nota esta bloqueada"' : ''}
                 aria-label="Puntaje desarrollo de ${esc(a.nombre)}" />`
            : '—';

          const grupoClase = `grupo-${a.grupo_dia}`;
          return `<tr data-documento="${esc(a.documento)}"
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
            <td class="c-desarrollo">${nota}</td>
            <td class="c-total"><b>${id ? a.puntaje_total_obtenido : '—'}</b></td>
            <td class="c-acciones">${acciones}</td>
          </tr>`;
        })
        .join('');

      // Solo reescribimos si cambio algo (evita perder el foco en los inputs)
      if (tbody.dataset.hash !== hash(nuevas)) {
        const foco = document.activeElement;
        const esNota = foco && foco.classList.contains('input-nota');
        const val = esNota ? foco.value : null;
        const pos = esNota ? foco.selectionStart : null;
        tbody.innerHTML = nuevas;
        tbody.dataset.hash = hash(nuevas);
        if (esNota) {
          const nuevo = tbody.querySelector(`.input-nota[data-id="${foco.dataset.id}"]`);
          if (nuevo) {
            nuevo.focus();
            try { novoSet(nuevo, val, pos); } catch { /* noop */ }
          }
        }
      }
      aplicarFiltros();
    }

    function novoSet(el, val, pos) {
      if (typeof val === 'string') el.value = val;
      if (typeof pos === 'number') try { el.setSelectionRange(pos, pos); } catch { /* noop */ }
    }

    async function refrescar() {
      try {
        const r = await fetch('/admin/api/entregas', { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        render(await r.json());
      } catch { /* transitorio */ }
    }

    setInterval(refrescar, 5000);

    tabla.addEventListener('input', (e) => {
      const inp = e.target.closest('.input-nota');
      if (!inp) return;
      const btn = $('.btn-guardar', inp.closest('tr'));
      if (btn) btn.hidden = false;
    });

    tabla.addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-guardar');
      if (!btn) return;
      const inp = $('.input-nota', btn.closest('tr'));
      const puntos = Number(inp.value);
      if (!Number.isFinite(puntos) || puntos < 0) return toast('Puntaje invalido', 'err');

      btn.disabled = true;
      btn.textContent = '...';
      try {
        const r = await fetch(`/admin/calificar/${btn.dataset.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ puntaje_desarrollo: puntos })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || 'Error');
        const id = btn.dataset.id;
        const enviado = !!(d.correo && d.correo.ok);
        if (enviado) falloEnvio.delete(id);
        else if (Number(d.pdf_enviado) !== 1) falloEnvio.add(id);
        let extra;
        if (Number(d.pdf_enviado) === 1 && enviado) {
          extra = ' — PDF enviado: nota bloqueada.';
        } else if (enviado) {
          extra = ' — PDF enviado por correo.';
        } else {
          extra = ` — PDF generado, correo NO enviado${d.correo && d.correo.error ? ': ' + d.correo.error : ''}.`;
        }
        toast(`Guardado. Total: ${d.puntaje_total_obtenido} pts` + extra, enviado ? 'ok' : 'err');
        await refrescar();
      } catch (err) {
        toast('No se pudo calificar: ' + err.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Guardar';
      }
    });

    /* ---------- Modal: devoluciones y correcciones ---------- */
    const modalCorr = $('#modalCorreccion');
    const corrTexto = $('#corrTexto');
    const corrSub = $('#corrSubtitulo');
    const btnGuardarCorr = $('#btnGuardarCorr');
    const btnCancelarCorr = $('#btnCancelarCorr');

    let corrId = null;

    function cerrarCorreccion() {
      modalCorr.hidden = true;
      corrId = null;
    }

    tabla.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-correccion');
      if (!btn) return;
      corrId = btn.dataset.id;
      const fila = btn.closest('tr');
      const nombreTd = fila ? fila.querySelector('td:nth-child(2)') : null;
      corrSub.textContent = nombreTd ? `${fila.dataset.documento} — ${nombreTd.textContent}` : '';
      corrTexto.value = devoluciones[corrId] || '';
      modalCorr.hidden = false;
      corrTexto.focus();
    });

    btnCancelarCorr.addEventListener('click', cerrarCorreccion);
    modalCorr.addEventListener('click', (e) => {
      if (e.target === modalCorr) cerrarCorreccion();
    });

    btnGuardarCorr.addEventListener('click', async () => {
      if (!corrId) return;
      btnGuardarCorr.disabled = true;
      btnGuardarCorr.textContent = '...';
      try {
        const r = await fetch(`/admin/devoluciones/${corrId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ devoluciones: corrTexto.value })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || 'Error');
        devoluciones[corrId] = d.devoluciones || '';
        const idCorr = corrId;
        let extra;
        if (Number(d.pdf_enviado) !== 1) {
          extra = ' (el PDF se generara al calificar).';
        } else if (d.correo && d.correo.ok) {
          falloEnvio.delete(idCorr);
          extra = ' — PDF reenviado por correo.';
        } else {
          falloEnvio.add(idCorr);
          extra = ` — PDF regenerado, correo NO enviado${d.correo && d.correo.error ? ': ' + d.correo.error : ''}.`;
        }
        toast(
          (d.devoluciones ? 'Correcciones guardadas.' : 'Correcciones borradas.') + extra,
          d.correo && d.correo.error ? 'err' : 'ok'
        );
        cerrarCorreccion();
        await refrescar();
      } catch (err) {
        toast('No se pudieron guardar las correcciones: ' + err.message, 'err');
      } finally {
        btnGuardarCorr.disabled = false;
        btnGuardarCorr.textContent = 'Guardar';
      }
    });

    aplicarFiltros();
  }

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

    if (btnCancelarP) {
      btnCancelarP.addEventListener('click', () => {
        formPregunta.reset();
        formPregunta.action = '/admin/preguntas';
        titulo.textContent = 'Nueva pregunta';
        btnCancelarP.hidden = true;
        syncTipo();
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
        $('#opciones').value = $('textarea[name=opciones]', src).value;
        $('#correctas').value = $('input[name=correctas]', src).value;
        if (selMateria) selMateria.value = $('select[name=materia_id]', src).value;
        formPregunta.action = `/admin/preguntas/${item.dataset.id}/editar`;
        titulo.textContent = 'Editar pregunta #' + item.dataset.id;
        btnCancelarP.hidden = false;
        syncTipo();
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
