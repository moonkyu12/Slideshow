// Classroom Slideshow - 백그라운드 서비스 워커
// 컨텍스트 메뉴 생성 및 URL 처리 담당

// 구글 드라이브 파일 ID 추출 패턴
const DRIVE_PATTERNS = [
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
  /\/presentation\/d\/([a-zA-Z0-9_-]+)/,
  /\/document\/d\/([a-zA-Z0-9_-]+)/,
  /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/
];

// 지원하는 파일 확장자
const PDF_EXTENSIONS = ['.pdf'];
const PPT_EXTENSIONS = ['.ppt', '.pptx', '.pptm'];

/**
 * URL에서 구글 드라이브 파일 ID를 추출합니다.
 */
function extractDriveFileId(url) {
  for (const pattern of DRIVE_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * URL을 통해 파일 타입을 감지합니다.
 */
function detectFileType(url) {
  const lowerUrl = url.toLowerCase();

  // 직접적인 파일 확장자 확인
  for (const ext of PDF_EXTENSIONS) {
    if (lowerUrl.includes(ext)) return 'pdf';
  }
  for (const ext of PPT_EXTENSIONS) {
    if (lowerUrl.includes(ext)) return 'pptx';
  }

  // 구글 드라이브/문서 URL 확인
  if (lowerUrl.includes('docs.google.com/presentation')) return 'pptx';
  if (lowerUrl.includes('drive.google.com')) return 'drive';

  // 기본값 - PDF로 시도
  return 'unknown';
}

/**
 * 적절한 파라미터를 포함한 뷰어 URL을 생성합니다.
 */
function buildViewerUrl(linkUrl) {
  const fileType = detectFileType(linkUrl);
  const driveFileId = extractDriveFileId(linkUrl);
  const viewerPage = chrome.runtime.getURL('viewer/viewer.html');

  const params = new URLSearchParams();

  if (driveFileId) {
    params.set('fileId', driveFileId);
    params.set('type', fileType === 'pdf' ? 'pdf' : 'pptx');
  } else {
    params.set('url', linkUrl);
    params.set('type', fileType);
  }

  return `${viewerPage}?${params.toString()}`;
}

// 설치 시 컨텍스트 메뉴 생성
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'classroom-slideshow',
    title: '슬라이드쇼',
    contexts: ['link'],
    documentUrlPatterns: [
      '*://classroom.google.com/*',
      '*://drive.google.com/*',
      '*://docs.google.com/*'
    ]
  });

  console.log('Classroom Slideshow: Context menu created');
});

// 컨텍스트 메뉴 클릭 처리
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'classroom-slideshow' && info.linkUrl) {
    const viewerUrl = buildViewerUrl(info.linkUrl);

    chrome.tabs.create({
      url: viewerUrl,
      active: true
    });

    console.log('Classroom Slideshow: Opening viewer for', info.linkUrl);
  }
});

// Manifest V3 확장프로그램 페이지의 CORS 제약을 우회하기 위해 PDF 요청을 프록시 처리
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchPdf') {
    fetch(request.url, { credentials: 'include' })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ success: true, dataUrl: reader.result }); // Base64 데이터 URL 전달
        };
        reader.onerror = () => {
          sendResponse({ success: false, error: 'Failed to read blob' });
        };
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        console.error("Background fetch error:", error);
        sendResponse({ success: false, error: error.toString() });
      });

    // 비동기적으로 응답을 보낼 것임을 나타내기 위해 true 반환
    return true;
  }
});
