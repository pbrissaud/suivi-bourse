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
          //    entries, ordered by ./sidebars.js and carrying no category,
          //    served at /docs/v5.
          //  - `4.x` is the frozen snapshot of the last v4 release (InfluxDB 3
          //    + Grafana + config files), served at /docs/v4.
          //  - `3.x` is the frozen snapshot of the last v3 release
          //    (Prometheus/Grafana + manual config), served at /docs/v3.
          //
          // ADR-0025: every version gets a path segment, the newest included.
          // The scheme is uniform instead of "everything is versioned except
          // the newest", which is the rule that produced the conflict: with
          // `path: ''`, /docs means *latest*, so a /docs/read-your-figures
          // link emitted by a v5 install would serve v6's page the day v6
          // ships — not a stale page, a correct page about another product,
          // reached from an app that promised to explain its own numbers.
          //
          // `lastVersion: 'current'` is unchanged: v5 stays the default
          // version (the navbar's `docId` items and the version dropdown's
          // active entry resolve to it), it simply no longer sits at the bare
          // /docs root. /docs is served by the client redirect declared in
          // `plugins` below, so a historical link still lands somewhere.
          //
          // THE LINK CONTRACT, for whoever wires the in-app convention bubble
          // (ADR-0016, issue #712 — today `app/web/src` holds zero `href="http`):
          //
          //     https://pbrissaud.github.io/suivi-bourse/{locale}/docs/v5/<page>#<anchor>
          //
          // with the locale segment **absent** for the default locale (English)
          // and `fr/` for French, e.g.
          //
          //     https://pbrissaud.github.io/suivi-bourse/docs/v5/read-your-figures#avg-cost
          //     https://pbrissaud.github.io/suivi-bourse/fr/docs/v5/read-your-figures#avg-cost
          //
          // The version segment is frozen at the **major**: a 5.1 install still
          // reads /docs/v5, doc versions being majors.
          lastVersion: 'current',
          versions: {
            current: {
              label: 'v5',
              path: 'v5',
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

  // /docs no longer names a version of its own (ADR-0025), so it is redirected
  // to the current one. The cost of the move is breaking deep URLs into /docs,
  // and this is the one release where it is nil: the corpus is rewritten from
  // zero, so none of those pages survives anyway — which is why a single
  // redirect of the root is enough and no per-page mapping is declared.
  //
  // The redirect is **client-side**: the plugin emits a build/docs/index.html
  // whose script and <meta http-equiv="refresh"> send the browser on. It
  // therefore does not exist under `pnpm start`, where /docs simply 404s — a
  // manual check in development would conclude the opposite of the truth. It
  // is verified on the built output:
  //
  //     pnpm build && cat build/docs/index.html   # → redirects to /docs/v5/
  //
  // `to` is deliberately the version root and not a page: it follows the head
  // of the thread wherever ./sidebars.js puts it.
  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/docs',
            to: '/docs/v5/',
          },
        ],
      },
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
