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
          screenshot.png is a slot, and it currently holds a neutral wireframe
          of the app's shell rather than a capture: the v5 interface does not
          exist yet to be photographed. What it must never hold again is the
          v3-era Grafana dashboard that was here — the first image of the
          project cannot be a tool that has left it.
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
  return (
    <Layout
      title={`Hello from ${siteConfig.title}`}
      description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
