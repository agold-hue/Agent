// pdf.js ships no types for the worker entry; we import it only for its side effect of registering
// globalThis.pdfjsWorker so the parser runs on the main thread (see lib/documents.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
