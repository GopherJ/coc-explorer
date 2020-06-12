import { fileColumnRegistrar } from '../fileColumnRegistrar';
import { fileHighlights } from '../fileSource';

fileColumnRegistrar.registerColumn('child', 'readonly', ({ source }) => ({
  draw() {
    const enabledNerdFont = source.config.get('icon.enableNerdfont');

    return {
      labelOnly: true,
      labelVisible: ({ node }) => node.readonly,
      drawNode(row, { node }) {
        if (node.readonly) {
          row.add(node.readonly ? (enabledNerdFont ? '' : 'RO') : '', {
            hl: fileHighlights.readonly,
          });
        }
      },
    };
  },
}));
