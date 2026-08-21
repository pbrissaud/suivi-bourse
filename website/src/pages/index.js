import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import styles from './index.module.css';
import ScreenshotPictureUrl from '@site/static/img/screenshot.png';

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
          screenshot.png is a slot, and it still holds a neutral wireframe of
          the app's shell rather than a capture. That is no longer for want of a
          subject: the four v5 pages exist (dashboard, shares, accounts, data).
          What is missing is the capture itself — a screenshot is taken from a
          running install with a real portfolio in it, which is a gesture nobody
          has made yet, not a page nobody has built. Replace the file, keep the
          alt text honest, and this comment goes with it. What the slot must
          never hold again is the v3-era Grafana dashboard that was here — the
          first image of the project cannot be a tool that has left it.
        */}
        <div className={clsx('row', styles.paddingTop)}>
        <img src={ScreenshotPictureUrl} alt="Placeholder for a capture of the SuiviBourse interface" />
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
