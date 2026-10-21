// Timestamp Inserter plugin — adds an AI quick-action button that inserts a
// "last modified" comment at the top of the current file.

module.exports = {
  activate(api) {
    api.addQuickAction({
      label: '⏱ Insert timestamp',
      prompt:
        'Add a comment at the very top of this code with the current date and time ' +
        'as a "Last modified" marker. Keep all existing code unchanged. ' +
        'Use the language-appropriate comment syntax.'
    });
    api.log('Timestamp Inserter plugin activated.');
  },
  deactivate() {}
};
