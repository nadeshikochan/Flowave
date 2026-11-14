window.__kumikoErrors = [];

window.addEventListener("error", function onKumikoError(event) {
  const item = {
    type: "error",
    message: event && event.message ? String(event.message) : "",
    source: event && event.filename ? String(event.filename) : "",
    line: event && event.lineno ? event.lineno : 0,
    column: event && event.colno ? event.colno : 0,
    stack: event && event.error && event.error.stack ? String(event.error.stack) : "",
  };
  window.__kumikoErrors.push(item);
  if (window.__kumikoErrors.length > 80) window.__kumikoErrors.shift();
  console.error(`[kumiko-render-error] ${JSON.stringify(item)}`);
});

window.addEventListener("unhandledrejection", function onKumikoUnhandledRejection(event) {
  const reason = event && event.reason ? event.reason : "";
  const item = {
    type: "unhandledrejection",
    message: reason && reason.message ? String(reason.message) : String(reason || ""),
    stack: reason && reason.stack ? String(reason.stack) : "",
  };
  window.__kumikoErrors.push(item);
  if (window.__kumikoErrors.length > 80) window.__kumikoErrors.shift();
  console.error(`[kumiko-render-error] ${JSON.stringify(item)}`);
});
