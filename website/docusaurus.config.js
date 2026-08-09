// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const {themes} = require('prism-react-renderer');
const lightTheme = themes.github;
const darkTheme = themes.dracula;

const organizationName = 'pbrissaud';
const projectName = 'suivi-bourse';

/** @type {import('@docusaurus/types').Config} */

const config = {
  title: 'Suivi Bourse',
  // The tagline names the product, never the stack it happens to sit on: v5 has
  // no stack, and the previous one ("with yfinance, InfluxDB 3 & Grafana") was
  // a fourth writer of the getting-started (ADR-0012, ADR-0025).
  tagline: 'Track your portfolio: your events in, your figures out, in one container',
  url: `https://${organizationName}.github.io`,
  baseUrl: `/${projectName}/`,
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  favicon: 'img/favicon.ico',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: organizationName, // Usually your GitHub org/user name.
  projectName: projectName, // Usually your repo name.

  // Even if you don't use internalization, you can use this field to set useful
  // metadata like html lang. For example, if your site is Chinese, you may want
  // to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl:
            `https://github.com/${organizationName}/${projectName}/tree/master/website/`,
          // Docs versioning:
          //  - `current` (the ./docs folder) is v5: a flat thread of eleven
          //    entries, ordered by ./sidebars.js and carrying no category.
          //  - `4.x` is the frozen snapshot of the last v4 release (InfluxDB 3
          //    + Grafana + config files), served at /docs/v4.
          //  - `3.x` is the frozen snapshot of the last v3 release
          //    (Prometheus/Grafana + manual config), served at /docs/v3.
          //
          // ADR-0025: every version gets a path segment, the newest included —
          // `current.path` becomes 'v5' and /docs redirects to it, so the
          // in-app ADR-0016 bubble can link to a page that stays v5's forever.
          // It moves with the corpus rewrite, which is what supplies the
          // redirect; leaving `path: ''` before then would 404 on /docs.
          //
          // The `unmaintained` banner below is one of the **two** devices that
          // warn a v4 reader, and neither is sufficient alone (ADR-0025):
          //  - the banner's real product is its *link*, the only thing that
          //    catches a deep landing from a search engine. Docusaurus points
          //    it at the same doc id in the latest version, falling back to
          //    that version's main doc — and under the rewritten corpus no v4
          //    or v3 page has a v5 counterpart, so all 33 of them land on the
          //    v5 home. That is the general case here, not the exception.
          //  - the admonition on the frozen `4.x` home says what the theme
          //    text cannot: *v5 exists and is not an upgrade*, rather than
          //    *this version is unmaintained*.
          //
          // A `4.2.3` whose only content is that announcement was refused: it
          // charges a restart and a changelog read to someone who asked for
          // nothing, and engraves into a frozen version a sentence nobody can
          // later correct. Both devices ship with the site, not with a release.
          lastVersion: 'current',
          versions: {
            current: {
              label: 'v5',
              path: '',
            },
            '4.x': {
              label: 'v4',
              path: 'v4',
              banner: 'unmaintained',
            },
            '3.x': {
              label: 'v3',
              path: 'v3',
              banner: 'unmaintained',
            },
          },
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'Suivi Bourse',
        logo: {
          alt: 'Suivi Bourse Logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'doc',
            docId: 'home',
            position: 'left',
            label: 'Documentation',
          },
          {
            type: 'docsVersionDropdown',
            position: 'right',
            dropdownActiveClassDisabled: true,
          },
          {
            href: `https://github.com/${organizationName}/${projectName}`,
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Suivi Bourse made by @pbrissaud. Built with Docusaurus.`,
      },
      prism: {
        theme: lightTheme,
        darkTheme: darkTheme,
        additionalLanguages: ['bash', 'yaml'],
      },
    }),
};

module.exports = config;
