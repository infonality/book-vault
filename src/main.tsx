import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ReaderWindow from "./pages/ReaderWindow";
import { applyAppearance, loadAppearance } from "./appearance";

// Reader windows load this same bundle with `?book=<id>`; anything else is the
// library. One entry point means one build and no duplicated styling.
const bookId = Number(new URLSearchParams(location.search).get("book"));
const isReader = Number.isFinite(bookId) && bookId > 0;

// Before the first paint, so a light theme never flashes dark on the way in.
// The reader takes the accent but not the light/dark choice: its chrome is a
// frame around the page, and the page has its own theme.
applyAppearance(loadAppearance(), { theme: !isReader });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isReader ? <ReaderWindow bookId={bookId} /> : <App />}
  </React.StrictMode>,
);
