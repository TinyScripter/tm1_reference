(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { searchEntries } = window.TM1Search;

  const STRINGS = {
    en: {
      search: 'Search functions, descriptions, examples…',
      ti: 'TurboIntegrator',
      rules: 'Rules',
      language: 'Language',
      back: '← Back to list',
      results: (n) => (n === 1 ? '1 result' : n + ' results'),
      none: 'No matching entries.',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      hint: 'Wildcards: * (any characters), ? (one character)',
      noData: 'No documentation data found for this section.',
      emptyTitle: 'No documentation yet',
      emptyText: 'The reference is not part of this extension. Download it once to use it offline. It is loaded from ibm.com (IBM Documentation, Planning Analytics 2.1.0, about 1 MB) only when you press the button, and only for the language selected in the dropdown. You can update it at any time.',
      download: 'Download documentation',
      retry: 'Try download again',
      importFile: 'Import from file…',
      importHint: 'If the download is blocked: import a documentation file made on another machine (npm run export-docs)',
      langMissingTitle: (n) => 'No ' + n + ' documentation',
      langMissingText: 'This language was not downloaded, for example because IBM currently does not provide it. Switch the language with the dropdown, or try the download again.',
      updateTitle: (date, name) => 'Update the ' + name + ' documentation from ibm.com' + (date ? ' (last update: ' + date + ')' : ''),
      downloading: (d, n) => (n ? 'Downloading… ' + d + ' / ' + n : 'Downloading…'),
      sample: 'This is sample data only. Run the documentation download to get the full reference.',
      syntax: 'Syntax',
      arguments: 'Arguments',
      returns: 'Returns',
      description: 'Description',
      remarks: 'Remarks',
      examples: 'Examples',
      copy: 'Copy',
      copied: 'Copied',
      insert: 'Insert',
      insertHint: 'Inserts the code with a tab stop for each argument',
      source: 'Source',
    },
    de: {
      search: 'Funktionen, Beschreibungen, Beispiele durchsuchen…',
      ti: 'TurboIntegrator',
      rules: 'Regeln',
      language: 'Sprache',
      back: '← Zurück zur Liste',
      results: (n) => (n === 1 ? '1 Treffer' : n + ' Treffer'),
      none: 'Keine passenden Einträge.',
      expandAll: 'Alle aufklappen',
      collapseAll: 'Alle zuklappen',
      hint: 'Platzhalter: * (beliebige Zeichen), ? (ein Zeichen)',
      noData: 'Für diesen Bereich wurden keine Dokumentationsdaten gefunden.',
      emptyTitle: 'Noch keine Dokumentation',
      emptyText: 'Die Referenz ist nicht Teil dieser Erweiterung. Lade sie einmal herunter, um sie offline zu nutzen. Sie wird nur beim Klick auf den Button von ibm.com geladen (IBM Documentation, Planning Analytics 2.1.0, etwa 1 MB) und nur für die im Auswahlfeld gewählte Sprache. Sie lässt sich jederzeit aktualisieren.',
      download: 'Dokumentation herunterladen',
      retry: 'Download erneut versuchen',
      importFile: 'Aus Datei importieren…',
      importHint: 'Falls der Download blockiert ist: eine auf einem anderen Rechner erzeugte Dokumentationsdatei importieren (npm run export-docs)',
      langMissingTitle: (n) => 'Keine Dokumentation auf ' + n,
      langMissingText: 'Diese Sprache wurde nicht geladen, zum Beispiel weil IBM sie derzeit nicht anbietet. Wechsle die Sprache über das Auswahlfeld oder versuche den Download erneut.',
      updateTitle: (date, name) => 'Dokumentation (' + name + ') von ibm.com aktualisieren' + (date ? ' (letzte Aktualisierung: ' + date + ')' : ''),
      downloading: (d, n) => (n ? 'Lade herunter… ' + d + ' / ' + n : 'Lade herunter…'),
      sample: 'Dies sind nur Beispieldaten. Führe den Dokumentations-Download aus, um die vollständige Referenz zu erhalten.',
      syntax: 'Syntax',
      arguments: 'Argumente',
      returns: 'Rückgabewert',
      description: 'Beschreibung',
      remarks: 'Hinweise',
      examples: 'Beispiele',
      copy: 'Kopieren',
      copied: 'Kopiert',
      insert: 'Einfügen',
      insertHint: 'Fügt den Code mit einem Tab-Stopp je Argument ein',
      source: 'Quelle',
    },
  };

  const saved = vscode.getState() || {};
  const state = {
    lang: 'en',
    languages: ['en', 'de'],
    data: null,
    status: null, // summary of the last download, null = nothing downloaded
    busy: false,
    progress: { done: 0, total: 0 },
    section: saved.section === 'rules' ? 'rules' : 'ti',
    query: saved.query || '',
    selected: saved.selected || null, // { section, id }
    // Expanded category groups, keyed "<section>:<index>" (the index is the same in both languages).
    expanded: new Set(Array.isArray(saved.expanded) ? saved.expanded : []),
  };

  const langNameOf = (l) => (l === 'de' ? 'Deutsch' : 'English');
  const app = document.getElementById('app');
  const t = () => STRINGS[state.lang] || STRINGS.en;

  function persist() {
    vscode.setState({
      section: state.section,
      query: state.query,
      selected: state.selected,
      expanded: Array.from(state.expanded),
    });
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children || [])) {
      if (child) node.appendChild(child);
    }
    return node;
  }

  function entryId(entry) {
    return entry.id || entry.name;
  }

  // ---- rendering -----------------------------------------------------------

  function renderShell() {
    app.textContent = '';

    const search = el('input', {
      type: 'search',
      id: 'search',
      placeholder: t().search,
      'aria-label': t().search,
      title: t().hint,
      value: state.query,
      oninput: (e) => {
        state.query = e.target.value;
        state.selected = null;
        persist();
        renderBody();
      },
    });

    const langSelect = el(
      'select',
      {
        'aria-label': t().language,
        title: t().language,
        onchange: (e) => vscode.postMessage({ type: 'setLanguage', lang: e.target.value }),
      },
      [
        el('option', { value: 'en', text: 'English' }),
        el('option', { value: 'de', text: 'Deutsch' }),
      ]
    );
    langSelect.value = state.lang;

    const hasDocs = !!state.data && ['ti', 'rules'].some((k) => state.data[k].entries.length > 0);

    if (!hasDocs) {
      // something is installed, but not for the selected language (IBM may not provide it)
      const missingLang = !!state.status;
      const langName = state.lang === 'de' ? 'Deutsch' : 'English';
      app.appendChild(
        el('div', { id: 'toolbar' }, [el('div', { class: 'row' }, [el('span', { class: 'spacer' }), el('span', { class: 'fixed' }, [langSelect])])])
      );
      app.appendChild(
        el('div', { class: 'emptystate' }, [
          el('h2', { text: missingLang ? t().langMissingTitle(langName) : t().emptyTitle }),
          el('p', { text: missingLang ? t().langMissingText : t().emptyText }),
          el('button', {
            class: 'primary',
            id: 'download',
            text: state.busy ? t().downloading(state.progress.done, state.progress.total) : missingLang ? t().retry : t().download,
            onclick: () => vscode.postMessage({ type: 'download' }),
            ...(state.busy ? { disabled: 'true' } : {}),
          }),
          el('button', {
            class: 'linkbtn',
            id: 'import',
            text: t().importFile,
            title: t().importHint,
            onclick: () => vscode.postMessage({ type: 'import' }),
            ...(state.busy ? { disabled: 'true' } : {}),
          }),
        ])
      );
      return;
    }

    const langInfo = (state.status && state.status.languages && state.status.languages[state.lang]) || {};
    const fetchedIso = langInfo.fetched || (state.status && state.status.fetched);
    const fetched = fetchedIso ? new Date(fetchedIso).toLocaleDateString(state.lang) : '';
    const updateButton = el('button', {
      class: 'iconbtn',
      id: 'update',
      title: t().updateTitle(fetched, langNameOf(state.lang)),
      'aria-label': t().updateTitle(fetched, langNameOf(state.lang)),
      text: '⟳',
      onclick: () => vscode.postMessage({ type: 'download' }),
      ...(state.busy ? { disabled: 'true' } : {}),
    });

    const tabs = el('div', { class: 'tabs', role: 'tablist' }, ['ti', 'rules'].map((s) =>
      el('button', {
        class: 'tab',
        role: 'tab',
        'aria-selected': String(state.section === s),
        text: t()[s],
        onclick: () => {
          state.section = s;
          state.selected = null;
          persist();
          renderShell();
        },
      })
    ));

    app.appendChild(
      el('div', { id: 'toolbar' }, [
        el('div', { class: 'row' }, [search, el('span', { class: 'fixed' }, [updateButton]), el('span', { class: 'fixed' }, [langSelect])]),
        state.busy ? el('div', { class: 'busyline', id: 'busyline', text: t().downloading(state.progress.done, state.progress.total) }) : null,
        tabs,
      ])
    );
    app.appendChild(el('div', { id: 'body' }));
    renderBody();
  }

  function currentSection() {
    return state.data ? state.data[state.section] : { meta: {}, entries: [] };
  }

  function renderBody() {
    const body = document.getElementById('body');
    if (!body) return;
    body.textContent = '';
    const section = currentSection();

    if (section.meta && section.meta.sample) {
      body.appendChild(el('div', { class: 'notice', text: t().sample }));
    }

    if (state.selected && state.selected.section === state.section) {
      const entry = section.entries.find((e) => entryId(e) === state.selected.id);
      if (entry) {
        renderDetail(body, entry);
        return;
      }
      state.selected = null;
    }

    if (state.query.trim() !== '') renderSearchResults(body, section);
    else renderCategories(body, section);
  }

  function selectEntry(sectionKey, entry) {
    state.section = sectionKey;
    state.selected = { section: sectionKey, id: entryId(entry) };
    persist();
    renderShell();
    window.scrollTo(0, 0);
  }

  function itemButton(sectionKey, entry) {
    return el(
      'button',
      { class: 'item', onclick: () => selectEntry(sectionKey, entry) },
      [
        el('span', { class: 'n', text: entry.name }),
        entry.summary ? el('span', { class: 's', text: entry.summary }) : null,
      ]
    );
  }

  /** Browse mode: one collapsible group per category, all collapsed by default. */
  function renderCategories(body, section) {
    if (section.entries.length === 0) {
      body.appendChild(el('p', { class: 'empty', text: t().noData }));
      return;
    }

    const groups = [];
    for (const entry of section.entries) {
      const last = groups[groups.length - 1];
      if (last && last.category === entry.category) last.entries.push(entry);
      else groups.push({ category: entry.category, entries: [entry] });
    }
    const keyOf = (i) => state.section + ':' + i;

    const setAll = (open) => {
      groups.forEach((_, i) => (open ? state.expanded.add(keyOf(i)) : state.expanded.delete(keyOf(i))));
      persist();
      renderBody();
    };
    body.appendChild(
      el('div', { class: 'treebar' }, [
        el('button', { text: t().expandAll, onclick: () => setAll(true) }),
        el('button', { text: t().collapseAll, onclick: () => setAll(false) }),
      ])
    );

    groups.forEach((group, i) => {
      const open = state.expanded.has(keyOf(i));
      const head = el(
        'button',
        {
          class: 'cathead',
          'aria-expanded': String(open),
          onclick: () => {
            if (state.expanded.has(keyOf(i))) state.expanded.delete(keyOf(i));
            else state.expanded.add(keyOf(i));
            persist();
            renderBody();
          },
        },
        [
          el('span', { class: 'chevron', 'aria-hidden': 'true', text: open ? '▾' : '▸' }),
          el('span', { class: 'catname', text: group.category || t()[state.section] }),
          el('span', { class: 'catcount', text: String(group.entries.length) }),
        ]
      );
      body.appendChild(head);
      if (open) {
        body.appendChild(
          el('div', { class: 'catbody' }, group.entries.map((entry) => itemButton(state.section, entry)))
        );
      }
    });
  }

  /** Search mode: looks through every category of the active section, ignoring collapse state. */
  function renderSearchResults(body, section) {
    const results = searchEntries(section.entries, state.query);
    if (results.length === 0) {
      body.appendChild(el('p', { class: 'empty', text: t().none }));
      return;
    }
    body.appendChild(el('div', { class: 'count', text: t().results(results.length) }));
    results.forEach((entry) => body.appendChild(itemButton(state.section, entry)));
  }

  function paragraphs(text) {
    return String(text || '')
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => el('p', { text: p.trim() }));
  }

  function codeBlock(code, kind, entry) {
    const buttons = [
      el('button', {
        text: t().copy,
        onclick: (e) => {
          vscode.postMessage({ type: 'copy', text: code });
          const btn = e.target;
          btn.textContent = t().copied;
          setTimeout(() => (btn.textContent = t().copy), 1200);
        },
      }),
    ];
    buttons.push(
      el('button', {
        text: t().insert,
        title: t().insertHint,
        onclick: () => vscode.postMessage({
            type: 'insert',
            text: code,
            kind,
            section: state.section,
            name: entry.name,
            syntax: entry.syntax,
          }),
      })
    );
    return el('div', {}, [el('div', { class: 'codebar' }, buttons), el('pre', { text: code })]);
  }

  function section(title, children) {
    const nodes = [].concat(children).filter(Boolean);
    if (nodes.length === 0) return null;
    return el('div', {}, [el('h3', { text: title })].concat(nodes));
  }

  function renderDetail(body, entry) {
    body.appendChild(
      el('button', {
        class: 'back',
        text: t().back,
        onclick: () => {
          state.selected = null;
          persist();
          renderBody();
        },
      })
    );
    body.appendChild(el('h2', { text: entry.name }));
    if (entry.category) body.appendChild(el('div', { class: 'cat', text: entry.category }));

    const parts = [
      entry.syntax ? section(t().syntax, codeBlock(entry.syntax, 'syntax', entry)) : null,
      entry.description || entry.summary ? section(t().description, paragraphs(entry.description || entry.summary)) : null,
      entry.params && entry.params.length
        ? section(
            t().arguments,
            el(
              'dl',
              {},
              entry.params.flatMap((p) => [el('dt', { text: p.name }), el('dd', { text: p.description || '' })])
            )
          )
        : null,
      entry.returns ? section(t().returns, paragraphs(entry.returns)) : null,
      entry.remarks ? section(t().remarks, paragraphs(entry.remarks)) : null,
      entry.examples && entry.examples.length
        ? section(
            t().examples,
            entry.examples.map((ex) =>
              el('div', {}, [
                ex.title ? el('p', { text: ex.title }) : null,
                ex.description ? el('p', { text: ex.description }) : null,
                codeBlock(ex.code || '', 'example', entry),
              ])
            )
          )
        : null,
      entry.source ? section(t().source, el('p', { class: 'cat', text: entry.source })) : null,
    ];
    parts.forEach((p) => p && body.appendChild(p));
  }

  // ---- messages ------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'data') {
      state.lang = msg.lang;
      state.languages = msg.languages;
      state.data = msg.data;
      state.status = msg.status || null;
      state.busy = !!msg.busy;
      state.progress = msg.progress || { done: 0, total: 0 };
      renderShell();
    } else if (msg.type === 'busy') {
      state.busy = !!msg.busy;
      state.progress = { done: msg.done || 0, total: msg.total || 0 };
      const label = t().downloading(state.progress.done, state.progress.total);
      const line = document.getElementById('busyline');
      const button = document.getElementById('download');
      if (line) line.textContent = label;
      else if (button) button.textContent = label;
      else renderShell();
      for (const id of ['update', 'download', 'import']) {
        const node = document.getElementById(id);
        if (node) node.disabled = state.busy;
      }
    } else if (msg.type === 'focusSearch') {
      const input = document.getElementById('search');
      if (input) {
        input.focus();
        input.select();
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
