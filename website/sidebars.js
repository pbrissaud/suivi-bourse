// @ts-check

/**
 * Two sections, one per reader: the person who tracks a portfolio, and the
 * person who runs the container. The files stay flat under `docs/` so that no
 * URL moves: the app links to `read-your-figures#<anchor>`,
 * `import-your-events#format` and `coming-from-v4`.
 *
 * The category labels are translated in
 * `i18n/<locale>/docusaurus-plugin-content-docs/current.json`.
 */

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  tutorialSidebar: [
    'home',
    {
      type: 'category',
      label: 'Using SuiviBourse',
      key: 'usage',
      collapsed: false,
      items: [
        'first-steps',
        'dashboard',
        'shares',
        'accounts',
        'ledger',
        'import-your-events',
        'benchmark',
        'agent',
        'read-your-figures',
        'your-taxation-model',
        'taxation-models-in-europe',
        'settings',
      ],
    },
    {
      type: 'category',
      label: 'Installation and administration',
      key: 'administration',
      collapsed: false,
      items: [
        'get-started',
        'install-without-docker',
        'configuration',
        'secure-access',
        'backup-and-update',
        'set-up-the-agent',
        'connect-your-own-agent',
        'system',
        'how-prices-are-collected',
        'rebuild-and-resolution',
        'coming-from-v4',
      ],
    },
    'release-notes',
  ],
};

module.exports = sidebars;
