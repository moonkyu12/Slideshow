// Classroom Slideshow - 뷰어 로직
// PDF.js 렌더링 + 네비게이션 + 전체화면 처리

(function () {
  'use strict';

  // ---------- 환경 설정 ----------
  const CURSOR_HIDE_DELAY = 3000;
  const PRELOAD_RANGE = 2; // 앞뒤로 미리 불러올 페이지 수

  // PDF.js 설정
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

  // DOM 요소
  const $ = (sel) => document.querySelector(sel);
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

  // ---------- 상태 변수 ----------
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let rendering = false;
  let pendingPage = null;
  let pageCache = new Map();
  let cursorTimer = null;
  let isGridOpen = false;

  // ---------- URL 파싱 ----------
  function getParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      url: params.get('url'),
      fileId: params.get('fileId'),
      type: params.get('type') || 'pdf'
    };
  }

  /**
   * 파라미터를 기반으로 PDF URL 생성
   */
  function buildPdfUrl(params) {
    if (params.fileId) {
      // 구글 드라이브 파일 - PPT는 내보내기 URL 사용, PDF는 직접 다운로드 사용
      if (params.type === 'pptx' || params.type === 'drive') {
        return `https://docs.google.com/presentation/d/${params.fileId}/export/pdf`;
      }
      // 드라이브의 PDF 파일일 경우 내보내기 시도 후 폴백
      return `https://drive.google.com/uc?export=download&id=${params.fileId}`;
    }

    if (params.url) {
      let url = params.url;

      // docs.google.com/viewer URL일 경우, 실제 URL 파라미터 추출
      if (url.includes('docs.google.com/viewer')) {
        const match = url.match(/url=([^&]+)/);
        if (match) {
          url = decodeURIComponent(match[1]);
        }
      }

      // 구글 드라이브 뷰어 URL일 경우, 직접 다운로드로 변환
      const driveMatch = url.match(/(?:drive|docs)\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }
      // 구글 슬라이드 URL
      const slidesMatch = url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
      if (slidesMatch) {
        return `https://docs.google.com/presentation/d/${slidesMatch[1]}/export/pdf`;
      }
      return url;
    }

    return null;
  }

  // ---------- 화면 표시/숨김 ----------
  const loadingScreen = $('#loading-screen');
  const loadingStatus = $('#loading-status');

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
    // 자동으로 전체화면 진입
    requestFullscreen();
  }

  // ---------- PDF 불러오기 ----------
  async function loadPdf(url) {
    showLoading('PDF 문서를 다운로드하고 있습니다...');

    console.log('Sending fetch request to background for URL:', url);
    chrome.runtime.sendMessage({ action: 'fetchPdf', url: url }, async (response) => {
      if (chrome.runtime.lastError) {
        showError('통신 오류: ' + chrome.runtime.lastError.message);
        return;
      }

      if (!response.success) {
        // 첫 번째 가져오기 실패 시 docs 또는 드라이브 URL 폴백
        if (url.includes('drive.google.com/uc?export=download') || url.includes('/export/pdf')) {
          // 구글의 엄격한 보기 전용 권한이나 내부 리다이렉트에 의해 차단되었을 수 있음.
          showError('파일 다운로드가 차단되었거나 로그인 권한이 필요합니다.\n이 파일은 구글 클래스룸 원본 페이지에서만 볼 수 있도록 설정되어 있을 수 있습니다.');
        } else {
          showError('파일을 가져오는 중 오류가 발생했습니다:\n' + (response.error || '알 수 없는 오류'));
        }
        return;
      }

      showLoading('슬라이드를 렌더링하는 중...');

      try {
        // Base64 데이터 URL을 Uint8Array로 변환
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

        // 다음 페이지 미리 불러오기
        preloadPages(1);

      } catch (err) {
        console.error('PDF parsing error:', err);
        showError(`PDF 변환에 실패했습니다.\n${err.message || '지원하지 않는 파일이거나 문서가 손상되었습니다.'}`);
      }
    });
  }

  // ---------- 페이지 렌더링 ----------
  async function renderPage(pageNum) {
    if (rendering) {
      pendingPage = pageNum;
      return;
    }

    rendering = true;
    currentPage = pageNum;

    // 즉시 UI 업데이트
    currentPageEl.textContent = pageNum;
    updateProgressBar();

    try {
      const page = await pdfDoc.getPage(pageNum);

      // 뷰포트에 맞게 스케일 계산
      const containerWidth = window.innerWidth;
      const containerHeight = window.innerHeight;
      const unscaledViewport = page.getViewport({ scale: 1 });

      const scaleX = containerWidth / unscaledViewport.width;
      const scaleY = containerHeight / unscaledViewport.height;
      const scale = Math.min(scaleX, scaleY);

      // 선명한 렌더링을 위해 더 높은 해상도 사용 (기기 픽셀 비율)
      const dpr = window.devicePixelRatio || 1;
      const renderScale = scale * dpr;
      const viewport = page.getViewport({ scale: renderScale });

      // 캔버스 크기 설정
      slideCanvas.width = viewport.width;
      slideCanvas.height = viewport.height;

      // 표시 크기 (CSS)
      slideCanvas.style.width = `${viewport.width / dpr}px`;
      slideCanvas.style.height = `${viewport.height / dpr}px`;

      // 렌더링
      const renderContext = {
        canvasContext: ctx,
        viewport: viewport
      };

      await page.render(renderContext).promise;

    } catch (err) {
      console.error('Render error:', err);
    }

    rendering = false;

    // 대기 중인 페이지가 있으면 렌더링
    if (pendingPage !== null) {
      const next = pendingPage;
      pendingPage = null;
      await renderPage(next);
    }
  }

  // ---------- 미리 불러오기 ----------
  async function preloadPages(currentNum) {
    for (let i = 1; i <= PRELOAD_RANGE; i++) {
      const nextPage = currentNum + i;
      const prevPage = currentNum - i;

      if (nextPage <= totalPages && !pageCache.has(nextPage)) {
        pdfDoc.getPage(nextPage).then(page => {
          pageCache.set(nextPage, page);
        }).catch(() => { });
      }
      if (prevPage >= 1 && !pageCache.has(prevPage)) {
        pdfDoc.getPage(prevPage).then(page => {
          pageCache.set(prevPage, page);
        }).catch(() => { });
      }
    }
  }

  // ---------- 네비게이션 ----------
  function goToPage(pageNum) {
    if (pageNum < 1 || pageNum > totalPages || pageNum === currentPage) return;

    // 슬라이드 전환 연출
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

  // ---------- 전체화면 ----------
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

  // ---------- 슬라이드 그리드 ----------
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

      // 썸네일 렌더링
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

  // ---------- 커서 자동 숨김 ----------
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

  // ---------- 키 입력 힌트 표시 ----------
  function showKeyHint(text) {
    const hint = document.createElement('div');
    hint.className = 'key-hint';
    hint.textContent = text;
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 800);
  }

  // ---------- 이벤트 핸들러 ----------

  // 키보드
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

  // 마우스 이동 -> 커서 표시
  document.addEventListener('mousemove', showCursor);

  // 네비게이션 클릭 영역
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

  // 컨트롤 바 버튼
  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); prevPage(); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); nextPage(); });
  btnFullscreen.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
  btnGrid.addEventListener('click', (e) => { e.stopPropagation(); toggleGrid(); });
  btnEscape.addEventListener('click', (e) => { e.stopPropagation(); window.close(); });
  gridClose.addEventListener('click', closeGrid);

  // 마우스 휠
  document.addEventListener('wheel', (e) => {
    if (isGridOpen) return;
    if (e.deltaY > 0) nextPage();
    else if (e.deltaY < 0) prevPage();
    showCursor();
  }, { passive: true });

  // 터치 지원 (스와이프)
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

    // 충분한 거리를 이동한 수평 스와이프만 허용
    if (absDx > 50 && absDx > absDy) {
      if (dx < 0) nextPage();
      else prevPage();
    }
  }, { passive: true });

  // 창 크기 조절 -> 현재 페이지 다시 렌더링
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfDoc) renderPage(currentPage);
    }, 200);
  });

  // 다시 시도 버튼
  retryBtn.addEventListener('click', () => {
    init();
  });

  // 전체화면 변경
  document.addEventListener('fullscreenchange', () => {
    if (pdfDoc) {
      setTimeout(() => renderPage(currentPage), 100);
    }
  });

  // ---------- 초기화 ----------
  function init() {
    const params = getParams();
    const urlLower = (params.url || '').toLowerCase();
    
    // PPT 파일 형식 여부 판단 (파라미터 타입, 주소 내 확장자 또는 슬라이드 주소)
    const isPpt = params.type === 'pptx' || 
                  urlLower.includes('.ppt') || 
                  urlLower.includes('docs.google.com/presentation');
                  
    if (isPpt) {
      console.log('Classroom Slideshow: PPT 형식 감지, 구글 네이티브 뷰어로 이동합니다.');
      let fileId = params.fileId;
      
      // 파일 ID가 없고 원본 주소가 있다면 정규식을 통해 ID를 강제 추출
      if (!fileId && params.url) {
        let match = params.url.match(/(?:drive|docs)\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (!match) match = params.url.match(/presentation\/d\/([a-zA-Z0-9_-]+)/);
        if (match) fileId = match[1];
      }
      
      if (fileId) {
        // 구글 공식 프레젠테이션 전체화면 모드로 화면 자체를 이동 (리다이렉트)
        window.location.replace(`https://docs.google.com/presentation/d/${fileId}/present`);
        return; // 이 함수 종료 (PDF.js 실행 안함)
      }
    }

    // PPT가 아닌 순수 PDF 파일 처리 로직
    const pdfUrl = buildPdfUrl(params);

    if (!pdfUrl) {
      showError('유효한 파일 URL이 없습니다. 올바른 링크를 우클릭했는지 확인해주세요.');
      return;
    }

    console.log('Loading PDF from:', pdfUrl);
    loadPdf(pdfUrl);
  }

  // 시작
  init();

})();
