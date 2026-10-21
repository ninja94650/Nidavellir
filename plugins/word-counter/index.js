// Word Counter plugin — displays word and character count in the status bar.
// Updates whenever a file is opened, saved, or run.

let api = null;

function updateCount(content) {
  if (!api || typeof content !== 'string') return;
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  const chars = content.length;
  api.updateStatusItem('wc', `Words: ${words} | Chars: ${chars}`);
}

module.exports = {
  activate(_api) {
    api = _api;
    api.addStatusItem({ id: 'wc', text: 'Words: —', tooltip: 'Word and character count' });
    api.onFileOpen(({ content })   => updateCount(content));
    api.onFileSave(({ content })   => updateCount(content));
    api.onBeforeRun(({ content })  => updateCount(content));
    api.log('Word Counter plugin activated.');
  },
  deactivate() { api = null; }
};
