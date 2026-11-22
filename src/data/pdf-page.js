'use strict';

function currentPageNumber(view) {
  const viewer = view?.viewer?.child?.pdfViewer
    || view?.viewer?.pdfViewer
    || view?.pdfViewer
    || null;
  const page = Number(viewer?.currentPageNumber || viewer?._location?.pageNumber);
  return page > 0 ? page : null;
}

module.exports = { currentPageNumber };
