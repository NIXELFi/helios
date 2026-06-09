// Print a built report straight from the app: load the self-contained HTML
// into a hidden same-origin iframe and call its print(). The native print
// dialog (WKWebView on macOS, WebView2 on Windows) offers "Save as PDF", so
// this IS the PDF exporter — no plugin, no temp file, no browser hop.
// Callers should catch and fall back to saveTextFile (HTML) if the webview
// refuses to print.

export async function printHtml(html: string): Promise<void> {
  const iframe = document.createElement("iframe");
  // Keep it renderable (display:none iframes print blank in WebKit) but
  // invisible and out of the layout.
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = html;
  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("Report frame did not load")), 5000);
      iframe.onload = () => {
        clearTimeout(fail);
        resolve();
      };
    });
    const win = iframe.contentWindow;
    if (!win) throw new Error("No print window");
    win.focus();
    win.print();
  } finally {
    // The print dialog snapshots the document; the frame can go shortly after.
    setTimeout(() => iframe.remove(), 60_000);
  }
}
