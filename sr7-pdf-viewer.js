/*!
 * SR7 PDF Viewer — Engine
 * SR7Themes (sr7themes.eu.org)
 *
 * Blogger installation:
 *   <div class="sr7-pdf" data-pdf="https://raw.githubusercontent.com/you/repo/main/file.pdf"></div>
 *
 * That is the only markup a customer needs to add. This script finds every
 * ".sr7-pdf" node on the page, builds the full viewer UI inside it, checks
 * domain authorization against a GitHub-hosted JSON file, then loads PDF.js
 * and renders the document.
 *
 * Load order on the page (in this exact order, once per page):
 *   1. sr7-pdf-icons.js
 *   2. sr7-pdf-viewer.css  (as a <link>)
 *   3. sr7-pdf-viewer.js   (this file)
 */

(function (global, document) {
  'use strict';

  var ICONS = global.SR7_PDF_ICONS || {};

  var SR7_PDF_CONFIG = {
    // Same delivery pattern as the SR7 Premium Video Player: static JSON
    // served from a GitHub raw URL, no server required.
    authUrl: 'https://raw.githubusercontent.com/sr7saim45/sr7themes/main/sr7-pdf-auth.example.json',
    pdfjsLib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    minScale: 0.4,
    maxScale: 4,
    scaleStep: 0.15,
    defaultScale: 1.15,
    thumbScale: 0.22,
    renderMargin: '1200px 0px 1200px 0px' // IntersectionObserver rootMargin for lazy page render
  };

  /* ================================================================
   * Utilities
   * ================================================================ */

  function icon(name) { return ICONS[name] || ''; }

  function el(tag, className, innerHTML) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (innerHTML !== undefined) node.innerHTML = innerHTML;
    return node;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var scriptCache = {};
  function loadScriptOnce(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-sr7-src="' + src + '"]');
      if (existing) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.sr7Src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load script: ' + src)); };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  /* ================================================================
   * Domain authorization gate (checked once, shared by every viewer
   * instance on the page)
   * ================================================================ */

  var AuthGate = {
    checked: false,
    authorized: false,
    reason: null,
    _promise: null,

    verify: function () {
      if (this._promise) return this._promise;
      var self = this;
      this._promise = fetch(SR7_PDF_CONFIG.authUrl, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('auth-http-' + res.status);
          return res.json();
        })
        .then(function (data) {
          var host = global.location.hostname.toLowerCase();
          var domains = Array.isArray(data.domains) ? data.domains : [];
          var domainOk = domains.some(function (d) {
            d = String(d).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
            return host === d || host.endsWith('.' + d);
          });
          var statusOk = data.status === 'active';
          var expiryOk = !data.expiry || new Date(data.expiry).getTime() > Date.now();

          self.authorized = domainOk && statusOk && expiryOk;
          self.reason = !domainOk ? 'domain' : (!statusOk ? 'status' : (!expiryOk ? 'expiry' : null));
          self.checked = true;
          return self.authorized;
        })
        .catch(function () {
          self.authorized = false;
          self.reason = 'network';
          self.checked = true;
          return false;
        });
      return this._promise;
    },

    message: function () {
      switch (this.reason) {
        case 'domain': return 'This domain is not authorized to use SR7 PDF Viewer.';
        case 'status': return 'This SR7 PDF Viewer license is not currently active.';
        case 'expiry': return 'This SR7 PDF Viewer license has expired.';
        default: return 'Unable to verify SR7 PDF Viewer authorization.';
      }
    }
  };

  /* ================================================================
   * PDF.js loader (loaded once, shared)
   * ================================================================ */

  var pdfjsReady = null;
  function ensurePdfJs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = loadScriptOnce(SR7_PDF_CONFIG.pdfjsLib).then(function () {
      if (!global.pdfjsLib) throw new Error('pdf.js did not initialize correctly.');
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = SR7_PDF_CONFIG.pdfjsWorker;
    });
    return pdfjsReady;
  }

  /* ================================================================
   * Viewer class — one instance per ".sr7-pdf" element
   * ================================================================ */

  function SR7PdfViewer(container) {
    this.container = container;
    this.url = container.getAttribute('data-pdf') || '';
    this.pdfDoc = null;
    this.numPages = 0;
    this.currentPage = 1;
    this.scale = SR7_PDF_CONFIG.defaultScale;
    this.rotation = 0;
    this.fitMode = null; // 'width' | 'page' | null (manual zoom)
    this.pageEls = [];   // { wrap, canvas, placeholder, rendered, rendering, textLayer }
    this.thumbEls = [];
    this.textCache = {}; // pageNumber -> lowercase concatenated text
    this.searchQuery = '';
    this.searchPages = [];   // page numbers containing the query
    this.searchMatchIndex = -1;
    this.passwordCallback = null;
    this.observer = null;
    this.sidebarOpen = window.innerWidth > 720;
    this.destroyed = false;

    this._buildShell();
    this._bindEvents();
    this._start();
  }

  /* -------------------- shell / DOM construction -------------------- */

  SR7PdfViewer.prototype._buildShell = function () {
    var c = this.container;
    c.classList.add('sr7-pdf-viewer');
    c.setAttribute('data-state', 'loading');
    c.setAttribute('data-sidebar', this.sidebarOpen ? 'open' : 'closed');
    c.setAttribute('tabindex', '0');
    c.innerHTML = '';

    var fileName = (this.url.split('/').pop() || 'Document').split('?')[0];

    // ---- Toolbar ----
    var toolbar = el('div', 'sr7-pdf-toolbar');

    var left = el('div', 'sr7-pdf-toolbar-group sr7-pdf-toolbar-left');
    left.innerHTML =
      '<button class="sr7-pdf-btn" data-action="toggle-sidebar" aria-label="Toggle thumbnails" title="Thumbnails">' + icon('menu') + '</button>' +
      '<span class="sr7-pdf-title">' + escapeHtml(decodeURIComponent(fileName)) + '</span>';

    var center = el('div', 'sr7-pdf-toolbar-group sr7-pdf-toolbar-center');
    center.innerHTML =
      '<button class="sr7-pdf-btn" data-action="prev" aria-label="Previous page" title="Previous page (\u2190)">' + icon('prev') + '</button>' +
      '<span class="sr7-pdf-pagejump">' +
      '<input class="sr7-pdf-pagenum" type="number" min="1" value="1" aria-label="Page number">' +
      '<span class="sr7-pdf-pagecount">/ 1</span></span>' +
      '<button class="sr7-pdf-btn" data-action="next" aria-label="Next page" title="Next page (\u2192)">' + icon('next') + '</button>';

    var right = el('div', 'sr7-pdf-toolbar-group sr7-pdf-toolbar-right');
    right.innerHTML =
      '<button class="sr7-pdf-btn" data-action="search-toggle" aria-label="Search" title="Search (/)">' + icon('search') + '</button>' +
      '<button class="sr7-pdf-btn" data-mobile-hide="true" data-action="zoom-out" aria-label="Zoom out" title="Zoom out (-)">' + icon('zoomOut') + '</button>' +
      '<span class="sr7-pdf-zoom-level" data-mobile-hide="true">100%</span>' +
      '<button class="sr7-pdf-btn" data-mobile-hide="true" data-action="zoom-in" aria-label="Zoom in" title="Zoom in (+)">' + icon('zoomIn') + '</button>' +
      '<div class="sr7-pdf-more-wrap">' +
      '  <button class="sr7-pdf-btn" data-action="more-toggle" aria-label="More options" title="More">' + icon('more') + '</button>' +
      '  <div class="sr7-pdf-more-menu">' +
      '    <button class="sr7-pdf-menu-item" data-action="zoom-in-mobile">' + icon('zoomIn') + '<span>Zoom in</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="zoom-out-mobile">' + icon('zoomOut') + '<span>Zoom out</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="fit-width">' + icon('fitWidth') + '<span>Fit width</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="fit-page">' + icon('fitPage') + '<span>Fit page</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="rotate">' + icon('rotate') + '<span>Rotate</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="download">' + icon('download') + '<span>Download</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="print">' + icon('print') + '<span>Print</span></button>' +
      '    <button class="sr7-pdf-menu-item" data-action="fullscreen">' + icon('fullscreen') + '<span>Full screen</span></button>' +
      '  </div>' +
      '</div>';

    toolbar.appendChild(left);
    toolbar.appendChild(center);
    toolbar.appendChild(right);

    // ---- Body: sidebar + canvas area ----
    var body = el('div', 'sr7-pdf-body');
    var sidebar = el('aside', 'sr7-pdf-sidebar');
    sidebar.setAttribute('aria-label', 'Page thumbnails');
    var thumbsWrap = el('div', 'sr7-pdf-thumbs');
    sidebar.appendChild(thumbsWrap);

    var canvasArea = el('main', 'sr7-pdf-canvas-area');

    var searchBar = el('div', 'sr7-pdf-search-bar');
    searchBar.innerHTML =
      '<button class="sr7-pdf-btn" data-action="search-prev" aria-label="Previous match" title="Previous match">' + icon('prev') + '</button>' +
      '<input class="sr7-pdf-search-input" type="text" placeholder="Search in document" aria-label="Search text">' +
      '<span class="sr7-pdf-search-count">0/0</span>' +
      '<button class="sr7-pdf-btn" data-action="search-next" aria-label="Next match" title="Next match">' + icon('next') + '</button>' +
      '<button class="sr7-pdf-btn" data-action="search-close" aria-label="Close search" title="Close">' + icon('close') + '</button>';

    var pages = el('div', 'sr7-pdf-pages');

    canvasArea.appendChild(searchBar);
    canvasArea.appendChild(pages);

    body.appendChild(sidebar);
    body.appendChild(canvasArea);

    // ---- Loading / error / password overlays ----
    var loading = el('div', 'sr7-pdf-loading',
      '<div class="sr7-pdf-spinner"></div><div class="sr7-pdf-loading-text">Loading document\u2026</div>');

    var error = el('div', 'sr7-pdf-error',
      icon('error') +
      '<div class="sr7-pdf-error-title">Something went wrong</div>' +
      '<div class="sr7-pdf-error-detail" data-role="error-detail">The document could not be loaded.</div>' +
      '<button class="sr7-pdf-error-retry" data-action="retry">Try again</button>');

    var passwordGate = el('div', 'sr7-pdf-password-gate');
    passwordGate.innerHTML =
      '<div class="sr7-pdf-password-card">' +
      icon('lock') +
      '<div class="sr7-pdf-password-title">Password required</div>' +
      '<div class="sr7-pdf-password-detail">This document is protected. Enter the password to open it.</div>' +
      '<div class="sr7-pdf-password-row">' +
      '  <input class="sr7-pdf-password-input" type="password" placeholder="Password" aria-label="Document password">' +
      '  <button class="sr7-pdf-password-toggle" data-action="toggle-password-visibility" aria-label="Show password">' + icon('eye') + '</button>' +
      '</div>' +
      '<div class="sr7-pdf-password-error" data-role="password-error"></div>' +
      '<button class="sr7-pdf-password-submit" data-action="submit-password">Unlock</button>' +
      '</div>';

    c.appendChild(toolbar);
    c.appendChild(body);
    c.appendChild(loading);
    c.appendChild(error);
    c.appendChild(passwordGate);

    // cache refs
    this.dom = {
      toolbar: toolbar,
      title: left.querySelector('.sr7-pdf-title'),
      pageNumInput: center.querySelector('.sr7-pdf-pagenum'),
      pageCount: center.querySelector('.sr7-pdf-pagecount'),
      zoomLevel: right.querySelector('.sr7-pdf-zoom-level'),
      moreMenu: right.querySelector('.sr7-pdf-more-menu'),
      sidebar: sidebar,
      thumbsWrap: thumbsWrap,
      canvasArea: canvasArea,
      pages: pages,
      searchBar: searchBar,
      searchInput: searchBar.querySelector('.sr7-pdf-search-input'),
      searchCount: searchBar.querySelector('.sr7-pdf-search-count'),
      loading: loading,
      loadingText: loading.querySelector('.sr7-pdf-loading-text'),
      error: error,
      errorDetail: error.querySelector('[data-role="error-detail"]'),
      passwordGate: passwordGate,
      passwordInput: passwordGate.querySelector('.sr7-pdf-password-input'),
      passwordError: passwordGate.querySelector('[data-role="password-error"]'),
      passwordToggle: passwordGate.querySelector('[data-action="toggle-password-visibility"]')
    };
  };

  /* -------------------- state helpers -------------------- */

  SR7PdfViewer.prototype._setState = function (state, detail) {
    this.container.setAttribute('data-state', state);
    if (state === 'error' && detail) this.dom.errorDetail.textContent = detail;
  };

  /* -------------------- event binding -------------------- */

  SR7PdfViewer.prototype._bindEvents = function () {
    var self = this;
    this.container.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      self._handleAction(btn.getAttribute('data-action'), e);
    });

    // Close the "more" menu when clicking outside it
    document.addEventListener('click', function (e) {
      if (!self.dom.moreMenu.classList.contains('sr7-open')) return;
      if (!e.target.closest('.sr7-pdf-more-wrap')) {
        self.dom.moreMenu.classList.remove('sr7-open');
      }
    });

    this.dom.pageNumInput.addEventListener('change', function () {
      var n = clamp(parseInt(this.value, 10) || 1, 1, self.numPages || 1);
      self.goToPage(n);
    });

    this.dom.searchInput.addEventListener('input', debounce(function () {
      self._runSearch(self.dom.searchInput.value);
    }, 260));

    this.dom.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); self._nextMatch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { self._closeSearch(); }
    });

    this.dom.passwordInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); self._submitPassword(); }
    });

    // Keyboard shortcuts, scoped to this viewer instance
    this.container.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea';
      if (typing && e.key !== 'Escape') return;

      if (e.key === 'ArrowRight' || e.key === 'PageDown') { self.goToPage(self.currentPage + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { self.goToPage(self.currentPage - 1); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') { self.zoomBy(SR7_PDF_CONFIG.scaleStep); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { self.zoomBy(-SR7_PDF_CONFIG.scaleStep); e.preventDefault(); }
      else if (e.key === '/') { self._openSearch(); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'f') { self.toggleFullscreen(); e.preventDefault(); }
      else if (e.key.toLowerCase() === 'r') { self.rotate(); e.preventDefault(); }
      else if (e.key === 'Escape') {
        if (self.dom.searchBar.classList.contains('sr7-open')) self._closeSearch();
        else if (self.container.classList.contains('sr7-fullscreen')) self.toggleFullscreen();
        e.preventDefault();
      }
    });

    window.addEventListener('resize', debounce(function () {
      if (self.fitMode) self._applyFitMode();
    }, 200));

    document.addEventListener('fullscreenchange', function () {
      var isFs = document.fullscreenElement === self.container;
      self.container.classList.toggle('sr7-fullscreen', isFs);
    });
  };

  SR7PdfViewer.prototype._handleAction = function (action, evt) {
    switch (action) {
      case 'toggle-sidebar': this._toggleSidebar(); break;
      case 'prev': this.goToPage(this.currentPage - 1); break;
      case 'next': this.goToPage(this.currentPage + 1); break;
      case 'search-toggle': this._toggleSearch(); break;
      case 'search-close': this._closeSearch(); break;
      case 'search-prev': this._nextMatch(-1); break;
      case 'search-next': this._nextMatch(1); break;
      case 'zoom-in': case 'zoom-in-mobile': this.zoomBy(SR7_PDF_CONFIG.scaleStep); break;
      case 'zoom-out': case 'zoom-out-mobile': this.zoomBy(-SR7_PDF_CONFIG.scaleStep); break;
      case 'fit-width': this.setFitMode('width'); this._closeMoreMenu(); break;
      case 'fit-page': this.setFitMode('page'); this._closeMoreMenu(); break;
      case 'rotate': this.rotate(); this._closeMoreMenu(); break;
      case 'download': this.download(); this._closeMoreMenu(); break;
      case 'print': this.print(); this._closeMoreMenu(); break;
      case 'fullscreen': this.toggleFullscreen(); this._closeMoreMenu(); break;
      case 'more-toggle': this.dom.moreMenu.classList.toggle('sr7-open'); break;
      case 'retry': this._start(); break;
      case 'toggle-password-visibility': this._togglePasswordVisibility(); break;
      case 'submit-password': this._submitPassword(); break;
    }
  };

  SR7PdfViewer.prototype._closeMoreMenu = function () { this.dom.moreMenu.classList.remove('sr7-open'); };

  SR7PdfViewer.prototype._toggleSidebar = function () {
    this.sidebarOpen = !this.sidebarOpen;
    this.container.setAttribute('data-sidebar', this.sidebarOpen ? 'open' : 'closed');
  };

  /* -------------------- boot sequence -------------------- */

  SR7PdfViewer.prototype._start = function () {
    var self = this;
    this._setState('loading');
    this.dom.loadingText.textContent = 'Verifying license\u2026';

    if (!this.url) {
      this._setState('error', 'No PDF source was provided for this viewer.');
      return;
    }

    AuthGate.verify().then(function (authorized) {
      if (self.destroyed) return;
      if (!authorized) {
        self._setState('error', AuthGate.message());
        return;
      }
      self.dom.loadingText.textContent = 'Loading document\u2026';
      return ensurePdfJs().then(function () { return self._openDocument(); });
    }).catch(function (err) {
      if (self.destroyed) return;
      self._setState('error', err && err.message ? err.message : 'Failed to load the document.');
    });
  };

  SR7PdfViewer.prototype._openDocument = function (password) {
    var self = this;
    var params = { url: this.url };
    if (password) params.password = password;

    var loadingTask = global.pdfjsLib.getDocument(params);
    loadingTask.onPassword = function (callback, reason) {
      self.passwordCallback = callback;
      var wrongPassword = reason === global.pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      self.dom.passwordError.textContent = wrongPassword ? 'Incorrect password. Try again.' : '';
      self._setState('password');
      setTimeout(function () { self.dom.passwordInput.focus(); }, 50);
    };

    return loadingTask.promise.then(function (pdfDoc) {
      if (self.destroyed) return;
      self.pdfDoc = pdfDoc;
      self.numPages = pdfDoc.numPages;
      self.passwordCallback = null;
      self._setState('ready');
      self.dom.pageCount.textContent = '/ ' + self.numPages;
      self.dom.pageNumInput.max = self.numPages;
      self._buildPageShells();
      self._buildThumbShells();
      self._setupLazyObserver();
      self._updateZoomLabel();
      self.goToPage(1, true);
    }).catch(function (err) {
      if (self.destroyed) return;
      if (err && err.name === 'PasswordException') return; // handled by onPassword
      self._setState('error', (err && err.message) || 'This PDF could not be opened.');
    });
  };

  /* -------------------- password gate -------------------- */

  SR7PdfViewer.prototype._togglePasswordVisibility = function () {
    var input = this.dom.passwordInput;
    var showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    this.dom.passwordToggle.innerHTML = showing ? icon('eye') : icon('eyeOff');
  };

  SR7PdfViewer.prototype._submitPassword = function () {
    var val = this.dom.passwordInput.value;
    if (!val) return;
    if (this.passwordCallback) {
      this._setState('loading');
      this.dom.loadingText.textContent = 'Unlocking document\u2026';
      this.passwordCallback(val);
    }
  };

  /* -------------------- page shells + lazy rendering -------------------- */

  SR7PdfViewer.prototype._buildPageShells = function () {
    var self = this;
    this.dom.pages.innerHTML = '';
    this.pageEls = [];

    this.pdfDoc.getPage(1).then(function (firstPage) {
      var baseViewport = firstPage.getViewport({ scale: 1, rotation: self.rotation });
      for (var i = 1; i <= self.numPages; i++) {
        var wrap = el('div', 'sr7-pdf-page');
        wrap.dataset.page = i;
        var w = Math.round(baseViewport.width * self.scale);
        var h = Math.round(baseViewport.height * self.scale);
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';

        var placeholder = el('div', 'sr7-pdf-page-placeholder');
        placeholder.style.width = '100%';
        placeholder.style.height = '100%';
        wrap.appendChild(placeholder);

        self.dom.pages.appendChild(wrap);
        self.pageEls.push({ wrap: wrap, placeholder: placeholder, canvas: null, textLayer: null, rendered: false, rendering: false });
      }
    });
  };

  SR7PdfViewer.prototype._setupLazyObserver = function () {
    var self = this;
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var pageNum = parseInt(entry.target.dataset.page, 10);
        if (entry.isIntersecting) {
          self._renderPage(pageNum);
        }
      });
    }, { root: this.dom.canvasArea, rootMargin: SR7_PDF_CONFIG.renderMargin });

    this.pageEls.forEach(function (p) { self.observer.observe(p.wrap); });

    // Track current page while scrolling, for the page-number indicator
    this.dom.canvasArea.addEventListener('scroll', debounce(function () {
      self._syncCurrentPageFromScroll();
    }, 120));
  };

  SR7PdfViewer.prototype._syncCurrentPageFromScroll = function () {
    var areaTop = this.dom.canvasArea.getBoundingClientRect().top;
    var best = this.currentPage, bestDist = Infinity;
    this.pageEls.forEach(function (p, idx) {
      var rect = p.wrap.getBoundingClientRect();
      var dist = Math.abs(rect.top - areaTop);
      if (dist < bestDist) { bestDist = dist; best = idx + 1; }
    });
    if (best !== this.currentPage) {
      this.currentPage = best;
      this.dom.pageNumInput.value = best;
      this._highlightThumb(best);
    }
  };

  SR7PdfViewer.prototype._renderPage = function (pageNum) {
    var self = this;
    var entry = this.pageEls[pageNum - 1];
    if (!entry || entry.rendered || entry.rendering) return;
    entry.rendering = true;

    this.pdfDoc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: self.scale, rotation: self.rotation });
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';

      var renderContext = {
        canvasContext: ctx,
        viewport: viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
      };

      return page.render(renderContext).promise.then(function () {
        if (self.destroyed) return;
        entry.wrap.style.width = Math.floor(viewport.width) + 'px';
        entry.wrap.style.height = Math.floor(viewport.height) + 'px';
        if (entry.placeholder) { entry.placeholder.remove(); entry.placeholder = null; }
        entry.wrap.appendChild(canvas);
        entry.canvas = canvas;
        entry.rendered = true;
        entry.rendering = false;
        return self._buildTextLayer(page, viewport, entry);
      });
    }).catch(function (err) {
      entry.rendering = false;
      // Individual page failures shouldn't take down the whole viewer.
      if (entry.placeholder) entry.placeholder.title = 'Failed to render this page.';
    });
  };

  SR7PdfViewer.prototype._buildTextLayer = function (page, viewport, entry) {
    var self = this;
    return page.getTextContent().then(function (textContent) {
      if (self.destroyed) return;
      var layer = el('div', 'sr7-pdf-text-layer');
      layer.style.width = Math.floor(viewport.width) + 'px';
      layer.style.height = Math.floor(viewport.height) + 'px';

      var plainText = '';
      textContent.items.forEach(function (item) {
        plainText += item.str + ' ';
        if (!item.str) return;
        var tx = global.pdfjsLib.Util.transform(viewport.transform, item.transform);
        var angleRad = Math.atan2(tx[1], tx[0]);
        var fontHeight = Math.hypot(tx[2], tx[3]);
        var span = document.createElement('span');
        span.textContent = item.str;
        span.style.left = tx[4] + 'px';
        span.style.top = (tx[5] - fontHeight) + 'px';
        span.style.fontSize = fontHeight + 'px';
        span.style.lineHeight = fontHeight + 'px';
        if (angleRad !== 0) span.style.transform = 'rotate(' + (angleRad * 180 / Math.PI) + 'deg)';
        layer.appendChild(span);
      });

      entry.wrap.appendChild(layer);
      entry.textLayer = layer;
      self.textCache[page.pageNumber] = plainText.toLowerCase();

      // If a search is active and this page is a match, (re)apply highlights.
      if (self.searchQuery && self.searchPages.indexOf(page.pageNumber) !== -1) {
        self._highlightPage(page.pageNumber);
      }
    });
  };

  /* -------------------- thumbnails -------------------- */

  SR7PdfViewer.prototype._buildThumbShells = function () {
    var self = this;
    this.dom.thumbsWrap.innerHTML = '';
    this.thumbEls = [];

    for (var i = 1; i <= this.numPages; i++) {
      var thumb = el('div', 'sr7-pdf-thumb');
      thumb.dataset.page = i;
      thumb.appendChild(el('div', 'sr7-pdf-thumb-placeholder'));
      var badge = el('span', 'sr7-pdf-thumb-num', String(i));
      thumb.appendChild(badge);
      thumb.addEventListener('click', function () {
        self.goToPage(parseInt(this.dataset.page, 10));
      });
      this.dom.thumbsWrap.appendChild(thumb);
      this.thumbEls.push({ el: thumb, rendered: false });
    }

    if (!this._thumbObserver) {
      this._thumbObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) self._renderThumb(parseInt(entry.target.dataset.page, 10));
        });
      }, { root: this.dom.sidebar, rootMargin: '600px 0px 600px 0px' });
    }
    this.thumbEls.forEach(function (t) { self._thumbObserver.observe(t.el); });
    this._highlightThumb(1);
  };

  SR7PdfViewer.prototype._renderThumb = function (pageNum) {
    var self = this;
    var entry = this.thumbEls[pageNum - 1];
    if (!entry || entry.rendered) return;
    entry.rendered = true;

    this.pdfDoc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: SR7_PDF_CONFIG.thumbScale, rotation: self.rotation });
      var canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
        var placeholder = entry.el.querySelector('.sr7-pdf-thumb-placeholder');
        if (placeholder) placeholder.remove();
        entry.el.insertBefore(canvas, entry.el.firstChild);
      });
    }).catch(function () { entry.rendered = false; });
  };

  SR7PdfViewer.prototype._highlightThumb = function (pageNum) {
    this.thumbEls.forEach(function (t, idx) {
      t.el.classList.toggle('sr7-current', idx + 1 === pageNum);
    });
  };

  /* -------------------- navigation -------------------- */

  SR7PdfViewer.prototype.goToPage = function (pageNum, silent) {
    pageNum = clamp(pageNum, 1, this.numPages || 1);
    this.currentPage = pageNum;
    this.dom.pageNumInput.value = pageNum;
    this._highlightThumb(pageNum);
    var entry = this.pageEls[pageNum - 1];
    if (entry) {
      entry.wrap.scrollIntoView({ block: silent ? 'start' : 'start', behavior: silent ? 'auto' : 'smooth' });
      this._renderPage(pageNum);
    }
  };

  /* -------------------- zoom / fit / rotate -------------------- */

  SR7PdfViewer.prototype._updateZoomLabel = function () {
    this.dom.zoomLevel.textContent = Math.round(this.scale / SR7_PDF_CONFIG.defaultScale * 100) + '%';
  };

  SR7PdfViewer.prototype.zoomBy = function (delta) {
    this.fitMode = null;
    this.setScale(this.scale + delta);
  };

  SR7PdfViewer.prototype.setScale = function (scale) {
    this.scale = clamp(scale, SR7_PDF_CONFIG.minScale, SR7_PDF_CONFIG.maxScale);
    this._updateZoomLabel();
    this._rerenderAll();
  };

  SR7PdfViewer.prototype.setFitMode = function (mode) {
    this.fitMode = mode;
    this._applyFitMode();
  };

  SR7PdfViewer.prototype._applyFitMode = function () {
    if (!this.fitMode || !this.pdfDoc) return;
    var self = this;
    this.pdfDoc.getPage(this.currentPage).then(function (page) {
      var viewport = page.getViewport({ scale: 1, rotation: self.rotation });
      var availW = self.dom.canvasArea.clientWidth - 32;
      var availH = self.dom.canvasArea.clientHeight - 48;
      var scale = self.fitMode === 'width'
        ? availW / viewport.width
        : Math.min(availW / viewport.width, availH / viewport.height);
      self.scale = clamp(scale, SR7_PDF_CONFIG.minScale, SR7_PDF_CONFIG.maxScale);
      self._updateZoomLabel();
      self._rerenderAll();
    });
  };

  SR7PdfViewer.prototype.rotate = function () {
    this.rotation = (this.rotation + 90) % 360;
    this._rerenderAll();
  };

  SR7PdfViewer.prototype._rerenderAll = function () {
    var self = this;
    var keepPage = this.currentPage;
    this.pageEls.forEach(function (entry) {
      entry.rendered = false;
      entry.rendering = false;
      entry.wrap.innerHTML = '';
      var ph = el('div', 'sr7-pdf-page-placeholder');
      ph.style.width = '100%';
      ph.style.height = '100%';
      entry.placeholder = ph;
      entry.wrap.appendChild(ph);
      entry.textLayer = null;
    });
    // Resize shells based on new scale/rotation using page 1 as reference
    this.pdfDoc.getPage(1).then(function (p) {
      var vp = p.getViewport({ scale: self.scale, rotation: self.rotation });
      self.pageEls.forEach(function (entry) {
        entry.wrap.style.width = Math.floor(vp.width) + 'px';
        entry.wrap.style.height = Math.floor(vp.height) + 'px';
      });
      self.goToPage(keepPage, true);
      // Re-render any pages currently in view
      self.pageEls.forEach(function (entry, idx) {
        var rect = entry.wrap.getBoundingClientRect();
        var areaRect = self.dom.canvasArea.getBoundingClientRect();
        if (rect.bottom > areaRect.top - 400 && rect.top < areaRect.bottom + 400) {
          self._renderPage(idx + 1);
        }
      });
    });
  };

  /* -------------------- search -------------------- */

  SR7PdfViewer.prototype._toggleSearch = function () {
    if (this.dom.searchBar.classList.contains('sr7-open')) this._closeSearch();
    else this._openSearch();
  };

  SR7PdfViewer.prototype._openSearch = function () {
    this.dom.searchBar.classList.add('sr7-open');
    this.dom.searchInput.focus();
    this.dom.searchInput.select();
  };

  SR7PdfViewer.prototype._closeSearch = function () {
    this.dom.searchBar.classList.remove('sr7-open');
    this._clearHighlights();
    this.container.focus();
  };

  SR7PdfViewer.prototype._runSearch = function (query) {
    var self = this;
    this._clearHighlights();
    query = (query || '').trim().toLowerCase();
    this.searchQuery = query;
    this.searchPages = [];
    this.searchMatchIndex = -1;

    if (!query) { this.dom.searchCount.textContent = '0/0'; return; }

    var tasks = [];
    for (var i = 1; i <= this.numPages; i++) {
      tasks.push(this._getPageText(i));
    }
    Promise.all(tasks).then(function () {
      for (var p = 1; p <= self.numPages; p++) {
        if ((self.textCache[p] || '').indexOf(query) !== -1) self.searchPages.push(p);
      }
      self.dom.searchCount.textContent = self.searchPages.length ? ('1/' + self.searchPages.length) : '0/0';
      if (self.searchPages.length) {
        self.searchMatchIndex = 0;
        self._jumpToSearchMatch();
      }
    });
  };

  SR7PdfViewer.prototype._getPageText = function (pageNum) {
    var self = this;
    if (this.textCache[pageNum] !== undefined) return Promise.resolve(this.textCache[pageNum]);
    return this.pdfDoc.getPage(pageNum).then(function (page) {
      return page.getTextContent().then(function (tc) {
        var text = tc.items.map(function (it) { return it.str; }).join(' ').toLowerCase();
        self.textCache[pageNum] = text;
        return text;
      });
    });
  };

  SR7PdfViewer.prototype._nextMatch = function (direction) {
    if (!this.searchPages.length) return;
    this.searchMatchIndex = (this.searchMatchIndex + direction + this.searchPages.length) % this.searchPages.length;
    this.dom.searchCount.textContent = (this.searchMatchIndex + 1) + '/' + this.searchPages.length;
    this._jumpToSearchMatch();
  };

  SR7PdfViewer.prototype._jumpToSearchMatch = function () {
    var pageNum = this.searchPages[this.searchMatchIndex];
    if (!pageNum) return;
    this.goToPage(pageNum);
    // Render may be async; highlight once the text layer exists.
    var self = this;
    var tryHighlight = function (attempts) {
      var entry = self.pageEls[pageNum - 1];
      if (entry && entry.textLayer) { self._highlightPage(pageNum); return; }
      if (attempts > 0) setTimeout(function () { tryHighlight(attempts - 1); }, 150);
    };
    tryHighlight(10);
  };

  SR7PdfViewer.prototype._highlightPage = function (pageNum) {
    var entry = this.pageEls[pageNum - 1];
    if (!entry || !entry.textLayer || !this.searchQuery) return;
    var query = this.searchQuery;
    var spans = entry.textLayer.querySelectorAll('span');
    var firstMark = null;
    spans.forEach(function (span) {
      var text = span.textContent;
      if (text.toLowerCase().indexOf(query) === -1) return;
      span.classList.add('sr7-mark');
      if (!firstMark) firstMark = span;
    });
    if (firstMark) {
      firstMark.classList.add('sr7-mark-active');
      firstMark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  SR7PdfViewer.prototype._clearHighlights = function () {
    this.pageEls.forEach(function (entry) {
      if (!entry.textLayer) return;
      entry.textLayer.querySelectorAll('span.sr7-mark').forEach(function (s) {
        s.classList.remove('sr7-mark', 'sr7-mark-active');
      });
    });
  };

  /* -------------------- fullscreen -------------------- */

  SR7PdfViewer.prototype.toggleFullscreen = function () {
    var c = this.container;
    if (document.fullscreenElement === c) {
      document.exitFullscreen && document.exitFullscreen();
    } else if (c.requestFullscreen) {
      c.requestFullscreen().catch(function () {
        // Fullscreen API blocked (e.g. iframe without allow="fullscreen") —
        // fall back to a CSS-only fullscreen overlay.
        c.classList.add('sr7-fullscreen');
      });
    } else {
      c.classList.toggle('sr7-fullscreen');
    }
  };

  /* -------------------- download / print --------------------
   * raw.githubusercontent.com sends Access-Control-Allow-Origin: *, so we
   * can fetch the PDF as a blob for a true same-origin download/print
   * experience. If the host doesn't allow CORS, we fall back to opening
   * the file in a new tab so the browser's native PDF tools take over.
   * ------------------------------------------------------------ */

  SR7PdfViewer.prototype._fetchBlobUrl = function () {
    return fetch(this.url, { mode: 'cors' }).then(function (res) {
      if (!res.ok) throw new Error('fetch-failed');
      return res.blob();
    }).then(function (blob) { return URL.createObjectURL(blob); });
  };

  SR7PdfViewer.prototype.download = function () {
    var self = this;
    var fallbackName = (this.url.split('/').pop() || 'document.pdf').split('?')[0];
    this._fetchBlobUrl().then(function (blobUrl) {
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = fallbackName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 4000);
    }).catch(function () {
      global.open(self.url, '_blank', 'noopener');
    });
  };

  SR7PdfViewer.prototype.print = function () {
    var self = this;
    this._fetchBlobUrl().then(function (blobUrl) {
      var iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.src = blobUrl;
      document.body.appendChild(iframe);
      iframe.onload = function () {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch (e) {
          global.open(blobUrl, '_blank', 'noopener');
        }
        setTimeout(function () {
          iframe.remove();
          URL.revokeObjectURL(blobUrl);
        }, 60000);
      };
    }).catch(function () {
      global.open(self.url, '_blank', 'noopener');
    });
  };

  SR7PdfViewer.prototype.destroy = function () {
    this.destroyed = true;
    if (this.observer) this.observer.disconnect();
    if (this._thumbObserver) this._thumbObserver.disconnect();
  };

  /* ================================================================
   * Auto-init
   * ================================================================ */

  function autoInit() {
    var nodes = document.querySelectorAll('.sr7-pdf');
    nodes.forEach(function (node) {
      if (node.__sr7pdf) return;
      node.__sr7pdf = new SR7PdfViewer(node);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  global.SR7PdfViewer = SR7PdfViewer;
  global.SR7_PDF_CONFIG = SR7_PDF_CONFIG;
})(window, document);
