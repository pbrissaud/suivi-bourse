// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const {themes} = require('prism-react-renderer');
const lightTheme = themes.github;
const darkTheme = themes.dracula;

const organizationName = 'pbrissaud';
const projectName = 'suivi-bourse';

// The **documentation** Crowdin project, and it is not the front's (ADR-0024).
// Two projects rather than one: the two corpora have different formats (ICU
// JSON against Markdown) and different rhythms — the front's catalogues move
// One project for the whole product, not one per surface (ADR-0024, amended by
// #739): a translation memory is per-project by default, so splitting them
// would let the interface and the page that explains it name the same figure
// two ways. The slug is written here because `editUrl` below is what sends a
// French reader to it; the root `crowdin.yml` names the same project through
// `CROWDIN_PROJECT_ID`.
const crowdinProject = 'suivi-bourse';

// Named once, read by `i18n` and by `editUrl`: the rule is "the default locale
// is the source", not "English is special", so a third language added to
// `locales` gets the Crowdin destination without anyone remembering to widen a
// comparison.
const defaultLocale = 'en';

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

  // The site is bilingual, and English is the **source** rather than one of two
  // translations (ADR-0024): the corpus is written in English, Crowdin reads it
  // and produces French. That is the same posture as the front's catalogues,
  // for the same reason — a source that is itself a translation has no author.
  //
  // `defaultLocale: 'en'` is also half of the link contract the product
  // consumes (ADR-0025): the locale segment is **absent** for the default
  // locale and `fr/` for French, which is exactly what Docusaurus emits — the
  // default locale at the baseUrl root, every other locale under its own
  // segment. `docusaurus build` builds **all** the declared locales, so /fr/
  // exists in the published output from this commit on; without it an in-app
  // bubble following a French reader's language would 404.
  //
  // The shape admits a third language without being redone — declare it here,
  // add it to `crowdin.yml`'s target, done — but adding one is not this
  // ticket's business.
  i18n: {
    defaultLocale: defaultLocale,
    locales: [defaultLocale, 'fr'],
    localeConfigs: {
      en: {label: 'English'},
      fr: {label: 'Français'},
    },
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          // "Edit this page" has **two destinations, one per locale**, and the
          // split is not cosmetic: a French page is not a file of this
          // repository that anyone may edit, it is the output of a Crowdin
          // import. Sending a French reader to GitHub invites a pull request
          // on a file the next import overwrites — the contribution is lost
          // and nobody is told. So English goes to the source file on GitHub,
          // and every other locale goes to the project that owns its strings.
          //
          // `editLocalizedFiles` stays at its default (false): there is no
          // localized file to point at, since translations live in Crowdin
          // until an import lands them.
          editUrl: ({locale, versionDocsDirPath, docPath}) =>
            locale === defaultLocale
              ? `https://github.com/${organizationName}/${projectName}/tree/master/website/${versionDocsDirPath}/${docPath}`
              : `https://crowdin.com/project/${crowdinProject}/${locale}`,
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
          // The language is reachable from the site itself, not only from the
          // app's link. `/fr/` is published (the build covers every declared
          // locale), so the reader an in-app bubble lands there needs the way
          // back — and the reader who wants French needs the way in. An
          // untranslated page under /fr/ shows its English source: that is the
          // fallback, not a hole.
          {
            type: 'localeDropdown',
            position: 'right',
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
        // **No computed value in a string the catalogues mirror.** Every theme
        // string below is extracted by `pnpm write-translations` into
        // `i18n/en/docusaurus-theme-classic/*.json`, and at build time the
        // catalogue *wins* over this file — for English too, not only for
        // French. A `new Date().getFullYear()` here was therefore frozen the
        // day the catalogue was generated: the English site would still read
        // 2026 on 1 January 2027, silently, and `write-translations` would
        // start producing a diff on a file nobody touched.
        //
        // The fix is at the cause rather than at the symptom — a year is the
        // only value here that changes without an author, so it goes. What
        // remains are literals, which drift only if someone edits this file
        // and forgets to regenerate; that is caught by the `i18n/en` no-diff
        // gate in .github/workflows/pr-checks.yml.
        copyright:
          'Copyright © Suivi Bourse made by @pbrissaud. Built with Docusaurus.',
      },
      prism: {
        theme: lightTheme,
        darkTheme: darkTheme,
        additionalLanguages: ['bash', 'yaml'],
      },
    }),
};

module.exports = config;
