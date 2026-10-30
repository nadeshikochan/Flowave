(function () {
  'use strict';
  // One delegated controller also handles lazily mounted lists and dialogs.
  const timers = new Map();
  let dragging = null;
  function show(element) {
    if (!(element instanceof Element)) return;
    clearTimeout(timers.get(element));
    element.classList.add('is-scrolling');
    timers.set(element, setTimeout(() => {
      timers.delete(element);
      if (dragging !== element) element.classList.remove('is-scrolling');
    }, 1200));
  }
  function gutter(event) {
    for (let element = event.target; element instanceof HTMLElement; element = element.parentElement) {
      if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) continue;
      const vertical = element.offsetWidth - element.clientWidth;
      const horizontal = element.offsetHeight - element.clientHeight;
      if (vertical < 4 && horizontal < 4) continue;
      const rect = element.getBoundingClientRect();
      if ((vertical > 3 && event.clientX >= rect.right - vertical && event.clientX <= rect.right) ||
          (horizontal > 3 && event.clientY >= rect.bottom - horizontal && event.clientY <= rect.bottom)) return element;
    }
    return null;
  }
  function release() {
    const element = dragging;
    dragging = null;
    if (element) show(element);
  }
  document.addEventListener('scroll', event => show(event.target === document ? document.scrollingElement : event.target), { capture: true, passive: true });
  document.addEventListener('pointermove', event => { const element = gutter(event); if (element) show(element); }, { passive: true });
  document.addEventListener('pointerdown', event => { dragging = gutter(event); if (dragging) show(dragging); }, { passive: true });
  window.addEventListener('pointerup', release, { passive: true });
  window.addEventListener('pointercancel', release, { passive: true });
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    dragging = null;
    for (const [element, timer] of timers) { clearTimeout(timer); element.classList.remove('is-scrolling'); }
    timers.clear();
  });
  document.documentElement.classList.add('scrollbars-ready');
})();
