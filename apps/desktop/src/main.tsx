import React from "react";
import ReactDOM from "react-dom/client";
import App from "./Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalCapture } from "./lib/breadcrumbs";
import "./styles.css";

// Start capturing diagnostic breadcrumbs (window errors, unhandled rejections,
// console.error/warn) before anything renders, so a crash during boot is still
// recorded for a bug report.
installGlobalCapture();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
