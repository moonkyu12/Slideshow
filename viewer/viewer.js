// =====================================================
// Classroom Slideshow - Viewer Logic
// PDF.js rendering + navigation + fullscreen
// =====================================================

(function () {
  'use strict';

  // ---------- Configuration ----------
  const CURSOR_HIDE_DELAY = 3000;
  const PRELOAD_RANGE = 2; // preload N pages ahead/behind

  // ---------- PDF.js Setup ----------
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  // ---------- DOM Elements ----------
  const $ = (sel) => document.querySelector(sel);
  const loadingScreen = $('#loading-screen');
  const loadingStatus = $('#loading-status');
  const errorScreen = $('#error-screen');
  const errorMessage = $('#error-message');
  const retryBtn = $('#retry-btn');
  const slideshowContainer = $('#slideshow-container');
  const slideCanvas = $('#slide-canvas');
  const ctx = slideCanvas.getContext('2d');
  const progressBar = $('#progress-bar');
  const currentPageEl = $('#current-page');
  const totalPagesEl = $('#total-pages');
  const btnPrev = $('#btn-prev');
  const btnNext = $('#btn-next');
  const btnFullscreen = $('#btn-fullscreen');
  const btnGrid = $('#btn-grid');
  const btnEscape = $('#btn-escape');
  const navPrev = $('#nav-prev');
  const navNext = $('#nav-next');
  const slideGridOverlay = $('#slide-grid-overlay');
  const gridContainer = $('#grid-container');
  const gridClose = $('#grid-close');

  // ---------- State ----------
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let rendering = false;
  let pendingPage = null;
  let pageCache = new Map();
  let cursorTimer = null;
  let isGridOpen = false;

  // ---------- URL Parsing ----------
  function getParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      url: params.get('url'),
      fileId: params.get('fileId'),
      type: params.get('type') || 'pdf'
    };
  }

  /**
   * Build the PDF URL based on params
   */
  function buildPdfUrl(params) {
    if (params.fileId) {
      // Google Drive file - use export URL for PPT or direct for PDF
      if (params.type === 'pptx' || params.type === 'drive') {
        return `https://docs.google.com/presentation/d/${params.fileId}/export/pdf`;
      }
      // For PDF files on Drive, try export, then fallback
      return `https://drive.google.com/uc?export=download&id=${params.fileId}`;
    }
    
    if (params.url) {
      let url = params.url;
      
      // If it's a docs.google.com/viewer URL, extract the actual URL parameter
      if (url.includes('docs.google.com/viewer')) {
         const match = url.match(/url=([^&]+)/);
         if (match) {
             url = decodeURIComponent(match[1]);
         }
      }

      // If it's a Google Drive view URL, convert to direct download
      const driveMatch = url.match(/(?:drive|docs)\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }
      // Google Slides URL
      const slidesMatch = url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
      if (slidesMatch) {
        return `https://docs.google.com/presentation/d/${slidesMatch[1]}/export/pdf`;
      }
      return url;
    }

    return null;
  }

  // ---------- Show/Hide Screens ----------
  function showLoading(message) {
    loadingScreen.style.display = 'flex';
    errorScreen.style.display = 'none';
    slideshowContainer.style.display = 'none';
    if (message) loadingStatus.textContent = message;
  }

  function showError(msg) {
    loadingScreen.style.display = 'none';
    errorScreen.style.display = 'flex';
    slideshowContainer.style.display = 'none';
    errorMessage.textContent = msg;
  }

  function showSlideshow() {
    loadingScreen.style.display = 'none';
    errorScreen.style.display = 'none';
    slideshowContainer.style.display = 'block';
    // Auto-enter fullscreen
    requestFullscreen();
  }

  // ---------- PDF Loading ----------
  async function loadPdf(url) {
    showLoading('PDF 문서를 다운로드하고 있습니다...');

    console.log('Sending fetch request to background for URL:', url);
    chrome.runtime.sendMessage({ action: 'fetchPdf', url: url }, async (response) => {
      if (chrome.runtime.lastError) {
        showError('통신 오류: ' + chrome.runtime.lastError.message);
        return;
      }
      
      if (!response.success) {
        // Fallback for docs or drive URLs if primary fetch fails
        if (url.includes('drive.google.com/uc?export=download') || url.includes('/export/pdf')) {
           // We might be blocked by Google's strict viewing-only permissions or internal redirects.
           showError('파일 다운로드가 차단되었거나 로그인 권한이 필요합니다.\n이 파일은 구글 클래스룸 원본 페이지에서만 볼 수 있도록 설정되어 있을 수 있습니다.');
        } else {
           showError('파일을 가져오는 중 오류가 발생했습니다:\n' + (response.error || '알 수 없는 오류'));
        }
        return;
      }

      showLoading('슬라이드를 렌더링하는 중...');
      
      try {
        // Convert Base64 dataUrl (e.g., 'data:application/pdf;base64,JVBERi...') to Uint8Array
        const base64Str = response.dataUrl.split(',')[1];
        const raw = atob(base64Str);
        const uint8Array = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
          uint8Array[i] = raw.charCodeAt(i);
        }

        const loadingTask = pdfjsLib.getDocument({
          data: uint8Array,
          cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
          cMapPacked: true,
        });

        loadingTask.onProgress = (progress) => {
          if (progress.total > 0) {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            loadingStatus.textContent = `렌더링 진행률... ${pct}%`;
          }
        };

        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;
        totalPagesEl.textContent = totalPages;

        await renderPage(1);
        showSlideshow();

        // Preload next pages
        preloadPages(1);

      } catch (err) {
        console.error('PDF parsing error:', err);
        showError(`PDF 변환에 실패했습니다.\n${err.message || '지원하지 않는 파일이거나 문서가 손상되었습니다.'}`);
      }
    });
  }

  // ---------- Page Rendering ----------
  async function renderPage(pageNum) {
    if (rendering) {
      pendingPage = pageNum;
      return;
    }

    rendering = true;
    currentPage = pageNum;

    // Update UI immediately
    currentPageEl.textContent = pageNum;
    updateProgressBar();

    try {
      const page = await pdfDoc.getPage(pageNum);

      // Calculate scale to fit the viewport
      const containerWidth = window.innerWidth;
      const containerHeight = window.innerHeight;
      const unscaledViewport = page.getViewport({ scale: 1 });

      const scaleX = containerWidth / unscaledViewport.width;
      const scaleY = containerHeight / unscaledViewport.height;
      const scale = Math.min(scaleX, scaleY);

      // Use higher resolution for crisp rendering (device pixel ratio)
      const dpr = window.devicePixelRatio || 1;
      const renderScale = scale * dpr;
      const viewport = page.getViewport({ scale: renderScale });

      // Set canvas dimensions
      slideCanvas.width = viewport.width;
      slideCanvas.height = viewport.height;

      // Display dimensions (CSS)
      slideCanvas.style.width = `${viewport.width / dpr}px`;
      slideCanvas.style.height = `${viewport.height / dpr}px`;

      // Render
      const renderContext = {
        canvasContext: ctx,
        viewport: viewport
      };

      await page.render(renderContext).promise;

    } catch (err) {
      console.error('Render error:', err);
    }

    rendering = false;

    // Render pending page if any
    if (pendingPage !== null) {
      const next = pendingPage;
      pendingPage = null;
      await renderPage(next);
    }
  }

  // ---------- Preloading ----------
  async function preloadPages(currentNum) {
    for (let i = 1; i <= PRELOAD_RANGE; i++) {
      const nextPage = currentNum + i;
      const prevPage = currentNum - i;

      if (nextPage <= totalPages && !pageCache.has(nextPage)) {
        pdfDoc.getPage(nextPage).then(page => {
          pageCache.set(nextPage, page);
        }).catch(() => {});
      }
      if (prevPage >= 1 && !pageCache.has(prevPage)) {
        pdfDoc.getPage(prevPage).then(page => {
          pageCache.set(prevPage, page);
        }).catch(() => {});
      }
    }
  }

  // ---------- Navigation ----------
  function goToPage(pageNum) {
    if (pageNum < 1 || pageNum > totalPages || pageNum === currentPage) return;

    // Slide transition
    slideCanvas.classList.add('transitioning');
    setTimeout(() => {
      renderPage(pageNum).then(() => {
        slideCanvas.classList.remove('transitioning');
        preloadPages(pageNum);
      });
    }, 120);
  }

  function nextPage() {
    if (currentPage < totalPages) {
      goToPage(currentPage + 1);
    }
  }

  function prevPage() {
    if (currentPage > 1) {
      goToPage(currentPage - 1);
    }
  }

  function updateProgressBar() {
    const progress = (currentPage / totalPages) * 100;
    progressBar.style.width = `${progress}%`;
  }

  // ---------- Fullscreen ----------
  function requestFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
  }

  function exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.webkitFullscreenElement) {
      document.webkitExitFullscreen();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      exitFullscreen();
    } else {
      requestFullscreen();
    }
  }

  // ---------- Slide Grid ----------
  async function openGrid() {
    isGridOpen = true;
    slideGridOverlay.style.display = 'block';
    gridContainer.innerHTML = '';

    for (let i = 1; i <= totalPages; i++) {
      const item = document.createElement('div');
      item.className = `grid-item${i === currentPage ? ' active' : ''}`;
      item.dataset.page = i;

      const thumbCanvas = document.createElement('canvas');
      const numberBadge = document.createElement('div');
      numberBadge.className = 'grid-item-number';
      numberBadge.textContent = i;

      item.appendChild(thumbCanvas);
      item.appendChild(numberBadge);
      gridContainer.appendChild(item);

      // Render thumbnail
      renderThumbnail(i, thumbCanvas);

      item.addEventListener('click', () => {
        goToPage(i);
        closeGrid();
      });
    }
  }

  async function renderThumbnail(pageNum, canvas) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 0.4 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const thumbCtx = canvas.getContext('2d');
      await page.render({
        canvasContext: thumbCtx,
        viewport: viewport
      }).promise;
    } catch (err) {
      console.error('Thumbnail render error:', err);
    }
  }

  function closeGrid() {
    isGridOpen = false;
    slideGridOverlay.style.display = 'none';
  }

  function toggleGrid() {
    if (isGridOpen) closeGrid();
    else openGrid();
  }

  // ---------- Cursor Auto-hide ----------
  function showCursor() {
    document.body.classList.add('show-cursor');
    slideshowContainer.classList.add('controls-visible');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(hideCursor, CURSOR_HIDE_DELAY);
  }

  function hideCursor() {
    if (isGridOpen) return;
    document.body.classList.remove('show-cursor');
    slideshowContainer.classList.remove('controls-visible');
  }

  // ---------- Key Hint Flash ----------
  function showKeyHint(text) {
    const hint = document.createElement('div');
    hint.className = 'key-hint';
    hint.textContent = text;
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 800);
  }

  // ---------- Event Handlers ----------

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (isGridOpen) {
      if (e.key === 'Escape' || e.key === 'g' || e.key === 'G') {
        closeGrid();
        e.preventDefault();
      }
      return;
    }

    showCursor();

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case ' ':
      case 'Enter':
      case 'PageDown':
        nextPage();
        e.preventDefault();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'Backspace':
      case 'PageUp':
        prevPage();
        e.preventDefault();
        break;
      case 'Home':
        goToPage(1);
        e.preventDefault();
        break;
      case 'End':
        goToPage(totalPages);
        e.preventDefault();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'g':
      case 'G':
        toggleGrid();
        break;
      case 'Escape':
        if (document.fullscreenElement) {
          exitFullscreen();
        } else {
          window.close();
        }
        break;
    }
  });

  // Mouse move → show cursor
  document.addEventListener('mousemove', showCursor);

  // Navigation click zones
  navPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    prevPage();
    showCursor();
  });

  navNext.addEventListener('click', (e) => {
    e.stopPropagation();
    nextPage();
    showCursor();
  });

  // Control bar buttons
  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); prevPage(); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); nextPage(); });
  btnFullscreen.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
  btnGrid.addEventListener('click', (e) => { e.stopPropagation(); toggleGrid(); });
  btnEscape.addEventListener('click', (e) => { e.stopPropagation(); window.close(); });
  gridClose.addEventListener('click', closeGrid);

  // Mouse wheel
  document.addEventListener('wheel', (e) => {
    if (isGridOpen) return;
    if (e.deltaY > 0) nextPage();
    else if (e.deltaY < 0) prevPage();
    showCursor();
  }, { passive: true });

  // Touch support (swipe)
  let touchStartX = 0;
  let touchStartY = 0;

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (isGridOpen) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Only horizontal swipes (with enough distance)
    if (absDx > 50 && absDx > absDy) {
      if (dx < 0) nextPage();
      else prevPage();
    }
  }, { passive: true });

  // Window resize → re-render current page
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfDoc) renderPage(currentPage);
    }, 200);
  });

  // Retry button
  retryBtn.addEventListener('click', () => {
    init();
  });

  // Fullscreen change
  document.addEventListener('fullscreenchange', () => {
    if (pdfDoc) {
      setTimeout(() => renderPage(currentPage), 100);
    }
  });

  // ---------- Initialize ----------
  function init() {
    const params = getParams();
    const pdfUrl = buildPdfUrl(params);

    if (!pdfUrl) {
      showError('유효한 파일 URL이 없습니다. 올바른 링크를 우클릭했는지 확인해주세요.');
      return;
    }

    console.log('Loading PDF from:', pdfUrl);
    loadPdf(pdfUrl);
  }

  // Start
  init();

})();
