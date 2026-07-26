import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ReaderWindow from "./pages/ReaderWindow";

// Reader windows load this same bundle with `?book=<id>`; anything else is the
// library. One entry point means one build and no duplicated styling.
const bookId = Number(new URLSearchParams(location.search).get("book"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {Number.isFinite(bookId) && bookId > 0 ? <ReaderWindow bookId={bookId} /> : <App />}
  </React.StrictMode>,
);
