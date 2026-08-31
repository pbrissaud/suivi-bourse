import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import ThemedImage from '@theme/ThemedImage';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <h1 className="hero__title">{siteConfig.title}</h1>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          {/*
            The call to action points at the guide, which is one command and one
            screen. `onBrokenLinks: 'throw'` checks this target like any other
            link, so it dies with the page it names — which is what it did to
            /docs/intro/getting-started. It carries the version segment for the
            same reason every other link does (ADR-0025): /docs is now a
            redirect, not a route.
          */}
          <Link
            className="button button--secondary button--lg"
            to="/docs/v5/get-started">
            Get started — one command ⏱️
          </Link>
        </div>
        {/*
          The capture, and it is one: the v5 dashboard of a portfolio that does
          not exist, over real prices. It is served in two grounds rather than
          one, because the page follows the reader's theme and a light shell on
          a dark page reads as a foreign object. `ThemedImage` swaps the source
          on the same switch the rest of the page uses, so there is no second
          mechanism to keep in step.

          What this slot must never hold again is the v3-era Grafana dashboard
          that was here: the first image of the project cannot be a tool that has
          left it.
        */}
        <div className={clsx('row', styles.paddingTop)}>
          <ThemedImage
            alt="The SuiviBourse dashboard: the total gain, the value of the portfolio drawn against what was paid into it, the day's movers and the accounts"
            sources={{
              light: useBaseUrl('/img/app-dashboard-light.png'),
              dark: useBaseUrl('/img/app-dashboard-dark.png'),
            }}
          />
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  /*
    The `title` below is the document's <title>: the browser tab, the search
    result and the OpenGraph card of the product's front page. Docusaurus
    renders it as `<title> | Suivi Bourse`, so it says what the product does
    rather than repeating its name — the scaffold's "Hello from Suivi Bourse"
    greeted the reader and described nothing.
  */
  return (
    <Layout
      title="Track your portfolio"
      description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
