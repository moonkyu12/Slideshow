// content.js - 구글 클래스룸 및 드라이브 페이지에 슬라이드쇼 버튼을 주입하는 스크립트
// 클레스룸에 들어가면 실행됨

console.log("Classroom Slideshow: Content script loaded at", window.location.href);

const BUTTON_ID = 'classroom-slideshow-btn';

// 지원하는 파일 확장자
const SUPPORTED_EXTENSIONS = ['.pdf', '.ppt', '.pptx', '.pptm'];

// 현제파일 또는 SUPPORTED_EXTENSIONS에 포함된 파일인지 확인
function isSupportedFilePage() {
    const title = document.title.toLowerCase();
    const url = window.location.href.toLowerCase();

    // 직접적인 URL 패턴 확인 (드라이브 및 문서 뷰어)
    if (url.includes('/file/d/') || url.includes('/view') || url.includes('drive.google.com/file') || url.includes('docs.google.com/viewer')) {
        return true;
    }

    // 확장자 존재 여부 확인 (제목에 확장자가 있으면 true 반환)
    for (const ext of SUPPORTED_EXTENSIONS) {
        if (title.includes(ext)) return true;
    }

    // iframe에 파일이 있는지 확인
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
        if (iframe.src && (iframe.src.includes('drive.google.com/file/d/') || iframe.src.includes('docs.google.com/viewer') || iframe.src.includes('/preview'))) {
            return true;
        }
    }

    // 클래스룸 과제 보기 내부의 텍스트 확인
    try {
        if (document.querySelector('div[role="toolbar"]')) {
            const allText = document.body.innerText.toLowerCase();
            if (allText.includes('.pdf') || allText.includes('.ppt')) {
                return true;
            }
        }
    } catch (e) {
        // 교차 출처 (cross-origin) 관련 오류 무시
    }

    return false;
}

/**
 * 파일 URL을 추출합니다. iframe 내부에 있다면 iframe URL을 사용하고, 그렇지 않다면 현재 페이지 URL을 사용합니다.
 */
function getFileUrl() {
    // 드라이브 파일을 보여주는 iframe이 있다면 해당 URL을 사용
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
        if (iframe.src && (iframe.src.includes('drive.google.com/file/d/') || iframe.src.includes('docs.google.com/viewer'))) {
            return iframe.src;
        }
    }
    // 그 외의 경우 현재 URL 반환
    return window.location.href;
}

/**
 * 슬라이드쇼 뷰어 열기
 */
function openSlideshow() {
    const fileUrl = getFileUrl();
    const viewerPageUrl = chrome.runtime.getURL('viewer/viewer.html');
    const params = new URLSearchParams();
    params.set('url', fileUrl);

    window.open(`${viewerPageUrl}?${params.toString()}`, '_blank');
}

/**
 * 플로팅 액션 버튼 주입
 */
function injectButton() {
    // 중복 주입 방지
    let container = document.getElementById(BUTTON_ID + '-container');
    if (container) {
        container.style.display = isSupportedFilePage() ? 'block' : 'none';
        return;
    }

    if (!isSupportedFilePage()) return;

    console.log("Classroom Slideshow: Injecting button (inline styled)");

    container = document.createElement('div');
    container.id = BUTTON_ID + '-container';

    // CSS 로드 실패 시에도 작동하도록 인라인 스타일 사용
    // 구글의 모달 오버레이를 덮어쓰기 위해 최댓값 z-index 사용
    container.style.cssText = `
        position: fixed !important;
        bottom: 30px !important;
        right: 30px !important;
        z-index: 2147483647 !important;
        pointer-events: auto !important;
    `;

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center; gap:8px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px; height:22px;">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
                <polygon points="10 8 16 10 10 12 10 8" fill="currentColor"></polygon>
            </svg>
            <span>이 파일로 슬라이드쇼 시작</span>
        </div>
    `;

    btn.style.cssText = `
        display: flex !important;
        background: linear-gradient(135deg, #4f7df9 0%, #3a5bd9 100%) !important;
        color: white !important;
        border: 2px solid #fff !important;
        padding: 14px 28px !important;
        border-radius: 50px !important;
        font-family: 'Inter', sans-serif !important;
        font-size: 16px !important;
        font-weight: bold !important;
        cursor: pointer !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 0 10px rgba(79, 125, 249, 0.8) !important;
        transition: transform 0.2s !important;
    `;

    btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'translateY(-3px) scale(1.05)';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'translateY(0) scale(1)';
    });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSlideshow();
    });

    container.appendChild(btn);

    // 최적의 추가 위치 찾기. 최상단 다이얼로그 혹은 document.documentElement
    const dialogs = document.querySelectorAll('[role="dialog"]');
    if (dialogs.length > 0) {
        dialogs[dialogs.length - 1].appendChild(container); // 최상위 오버레이에 추가
    } else {
        document.documentElement.appendChild(container); // overflow hidden을 피하기 위해 body 외부에 추가
    }

    // iframe 환경 조정
    try {
        if (window !== window.top) {
            container.style.right = '40px !important'; // iframe 내부일 때 버튼 위치 조정
        }
    } catch (e) {
        container.style.right = '40px !important';
    }
}

// 초기 주입 시도
setTimeout(injectButton, 1000);
setTimeout(injectButton, 3000);

// 클래스룸 내 동적 페이지 이동을 감지하기 위한 MutationObserver 사용
const observer = new MutationObserver((mutations) => {
    if (observer.timer) clearTimeout(observer.timer);
    // 디바운스 처리
    observer.timer = setTimeout(() => {
        injectButton();
    }, 1500);
});

observer.observe(document.body, { childList: true, subtree: true });
